"""Shared PUBLIC projections and fenced single-resource admissions on the PG2 DAL."""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg import Connection
from psycopg_pool import PoolClosed, PoolTimeout

from stark_trading_os.control.public_data_models import PublicDataPayload, PublicDataResource
from stark_trading_os.control.public_data_policy import DAY_MS, ProviderScope
from stark_trading_os.control.public_data_store import (
    PublicDataStoreError,
    StoredPublicData,
    _payload,
    _state,
)
from stark_trading_os.integrations.public_data.models import Mode

from .access import AccessRejected, RepositoryAccessContract
from .pool import PersistenceUnavailable, PgRepositoryPool

RESOURCES: dict[ProviderScope, PublicDataResource] = {
    "binance": "markets",
    "coingecko": "assets",
    "blockbeats": "news",
}
LEASE_MS = 60000


@dataclass(frozen=True)
class Ticket:
    request_id: UUID
    owner_id: UUID
    scope: ProviderScope
    mode: Mode
    epoch: int
    lease_until_ms: int
    interval_ms: int


@dataclass(frozen=True)
class Admission:
    state: str
    ticket: Ticket | None = None
    next_at_ms: int | None = None
    revision: int | None = None


def _now(connection: Connection[dict[str, Any]]) -> int:
    row = connection.execute(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms"
    ).fetchone()
    assert row is not None
    return int(row["ms"])


def _decode(row: dict[str, Any]) -> StoredPublicData:
    if (row["tenant_scope"], row["schema_version"], row["projection_version"]) != (
        "PUBLIC",
        "AstarterPublicData.v1",
        "public-data-projection.v1",
    ):
        raise PublicDataStoreError()
    return _state(
        row["resource"],
        row["mode"],
        PublicDataPayload.model_validate_json(row["payload_json"]),
        PublicDataPayload.model_validate_json(row["last_good_json"])
        if row["last_good_json"] is not None
        else None,
        row["fetched_at_ms"],
        row["refresh_at_ms"],
        row["revision"],
    )


class PublicRepository:
    """No setup on construction; policy rows are explicit owner-provisioned state."""

    def __init__(self, pool: PgRepositoryPool, *, mode: Mode):
        if pool.access_contract is not RepositoryAccessContract.PUBLIC_DATA_V1 or mode not in {
            "offline_fixture",
            "live_readonly",
        }:
            raise ValueError("PUBLIC_REPOSITORY_CONFIGURATION")
        self.pool, self.mode = pool, mode

    def clock_ms(self) -> int:
        """Coordination time only; never rewrites provider observation timestamps."""
        try:
            with self.pool.transaction() as c:
                return _now(c)
        except (ValueError, PersistenceUnavailable, PoolClosed, PoolTimeout):
            raise PublicDataStoreError() from None

    def _key(self, scope: ProviderScope) -> str:
        if scope not in RESOURCES:
            raise ValueError("PUBLIC_SCOPE")
        return f"PUBLIC:{self.mode}:{scope}"

    def _budget(self, c: Connection[dict[str, Any]], scope: ProviderScope) -> dict[str, Any]:
        row = c.execute(
            "SELECT * FROM public_data.budgets WHERE scope=%s AND mode=%s FOR UPDATE",
            (scope, self.mode),
        ).fetchone()
        if row is None:
            raise ValueError("PUBLIC_POLICY_NOT_PROVISIONED")
        return row

    def _attempt(self, c: Connection[dict[str, Any]], request_id: UUID) -> dict[str, Any] | None:
        return c.execute(
            "SELECT * FROM public_data.attempts WHERE request_id=%s AND mode=%s",
            (request_id, self.mode),
        ).fetchone()

    def reserve(self, scope: ProviderScope, request_id: UUID, owner_id: UUID) -> Admission:
        if type(request_id) is not UUID or type(owner_id) is not UUID:
            raise ValueError("PUBLIC_REQUEST_ID")
        with self.pool.transaction(write=True, scope_id=self._key(scope)) as c:
            b = self._budget(c, scope)
            now = _now(c)
            previous = self._attempt(c, request_id)
            if previous is not None:
                if previous["scope"] != scope:
                    raise ValueError("PUBLIC_REQUEST_CONFLICT")
                # Even a RESERVED readback is not permission to replay uncertain IO.
                state = previous["state"]
                if state == "RESERVED" and now >= previous["lease_until_ms"]:
                    self._expire(c, previous)
                    state = "EXPIRED"
                return Admission(state, revision=previous["revision"])
            if b["active_request"] is not None:
                active = self._attempt(c, b["active_request"])
                if active is None:
                    raise ValueError("PUBLIC_LEDGER_INCONSISTENT")
                if active["state"] == "RESERVED" and now < active["lease_until_ms"]:
                    return Admission("BUSY", next_at_ms=active["lease_until_ms"])
                if active["state"] == "RESERVED":
                    self._expire(c, active)
            if now >= b["valid_until_ms"]:
                return Admission("BUDGET_EXPIRED")
            snapshot = c.execute(
                "SELECT refresh_at_ms FROM public_data.snapshots WHERE resource=%s AND mode=%s",
                (RESOURCES[scope], self.mode),
            ).fetchone()
            deadline = max(
                b["last_wall_ms"], b["next_at_ms"], snapshot["refresh_at_ms"] if snapshot else 0
            )
            day = now // DAY_MS
            spent = b["reserved"] if day <= b["day"] else 0
            if b["total_reserved"] + b["weight"] > b["total_cap"]:
                return Admission("TOTAL_CAP")
            if spent + b["weight"] > b["daily_cap"]:
                return Admission("DAILY_CAP", next_at_ms=(max(day, b["day"]) + 1) * DAY_MS)
            if now < deadline:
                return Admission("NOT_DUE", next_at_ms=deadline)
            epoch = b["epoch"] + 1
            lease = now + LEASE_MS
            if lease > b["valid_until_ms"]:
                return Admission("BUDGET_EXPIRED")
            c.execute(
                "INSERT INTO public_data.attempts "
                "(request_id,mode,scope,epoch,owner_id,started_at_ms,lease_until_ms,state) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,'RESERVED')",
                (request_id, self.mode, scope, epoch, owner_id, now, lease),
            )
            c.execute(
                "UPDATE public_data.budgets SET day=%s,reserved=%s,"
                "total_reserved=total_reserved+weight,last_wall_ms=%s,next_at_ms=%s,"
                "epoch=%s,active_request=%s WHERE scope=%s AND mode=%s",
                (
                    day,
                    spent + b["weight"],
                    now,
                    now + max(60000, b["interval_ms"]),
                    epoch,
                    request_id,
                    scope,
                    self.mode,
                ),
            )
            return Admission(
                "RESERVED",
                Ticket(request_id, owner_id, scope, self.mode, epoch, lease, b["interval_ms"]),
            )

    def _expire(self, c: Connection[dict[str, Any]], a: dict[str, Any]) -> None:
        c.execute(
            "UPDATE public_data.attempts SET state='EXPIRED' "
            "WHERE request_id=%s AND mode=%s AND state='RESERVED'",
            (a["request_id"], self.mode),
        )
        c.execute(
            "UPDATE public_data.budgets SET active_request=NULL "
            "WHERE scope=%s AND mode=%s AND active_request=%s",
            (a["scope"], self.mode, a["request_id"]),
        )

    def _owned(self, c: Connection[dict[str, Any]], t: Ticket) -> tuple[dict[str, Any], int]:
        if t.mode != self.mode:
            raise ValueError("PUBLIC_STALE_OWNER")
        b = self._budget(c, t.scope)
        a, now = self._attempt(c, t.request_id), _now(c)
        if (
            a is None
            or a["state"] != "RESERVED"
            or a["owner_id"] != t.owner_id
            or a["scope"] != t.scope
            or a["epoch"] != t.epoch
            or b["active_request"] != t.request_id
            or b["epoch"] != t.epoch
            or now >= a["lease_until_ms"]
            or now < b["last_wall_ms"]
            or now >= b["valid_until_ms"]
        ):
            raise ValueError("PUBLIC_STALE_OWNER")
        return b, now

    def deadline(self, t: Ticket, deadline_ms: int) -> None:
        if type(deadline_ms) is not int or not 0 <= deadline_ms <= 253402300799999:
            raise ValueError("PUBLIC_DEADLINE")
        with self.pool.transaction(write=True, scope_id=self._key(t.scope)) as c:
            b, now = self._owned(c, t)
            a = self._attempt(c, t.request_id)
            assert a is not None
            recorded = max(deadline_ms, now + b["interval_ms"], a["deadline_ms"] or 0)
            # Persist RetryAfter before snapshot/receipt commit. Never shorten an unknown hold.
            c.execute(
                "UPDATE public_data.attempts SET deadline_ms=%s WHERE request_id=%s AND mode=%s",
                (recorded, t.request_id, self.mode),
            )
            c.execute(
                "UPDATE public_data.budgets SET last_wall_ms=%s,next_at_ms=%s "
                "WHERE scope=%s AND mode=%s",
                (now, max(recorded, b["next_at_ms"]), t.scope, self.mode),
            )

    def unknown(self, t: Ticket) -> None:
        with self.pool.transaction(write=True, scope_id=self._key(t.scope)) as c:
            self._owned(c, t)
            c.execute(
                "UPDATE public_data.attempts SET state='UNKNOWN' WHERE request_id=%s AND mode=%s",
                (t.request_id, self.mode),
            )
            c.execute(
                "UPDATE public_data.budgets SET active_request=NULL,"
                "next_at_ms=greatest(next_at_ms,%s) WHERE scope=%s AND mode=%s",
                (t.lease_until_ms, t.scope, self.mode),
            )

    def status(self, request_id: UUID, *, scope: ProviderScope | None = None) -> Admission:
        if type(request_id) is not UUID:
            raise ValueError("PUBLIC_REQUEST_ID")
        if scope is not None and scope not in RESOURCES:
            raise ValueError("PUBLIC_SCOPE")
        with self.pool.transaction() as c:
            a = self._attempt(c, request_id)
            if a is not None and scope is not None and a["scope"] != scope:
                raise ValueError("PUBLIC_REQUEST_CONFLICT")
            return Admission(a["state"], revision=a["revision"]) if a else Admission("NOT_FOUND")


class PgPublicStore:
    """Existing synchronous snapshot interface. Only a current admission can write."""

    def __init__(self, repository: PublicRepository, *, ticket: Ticket | None = None):
        self.repository, self.ticket = repository, ticket

    @property
    def mode(self) -> Mode:
        return self.repository.mode

    def load(self, resource: PublicDataResource) -> StoredPublicData | None:
        return self.load_at(resource)[0]

    def load_at(self, resource: PublicDataResource) -> tuple[StoredPublicData | None, int]:
        """Snapshot and DB observation clock share the same checked read transaction."""
        if resource not in {*RESOURCES.values(), "explorer/capabilities"}:
            raise PublicDataStoreError()
        try:
            with self.repository.pool.transaction() as c:
                row = c.execute(
                    "SELECT * FROM public_data.snapshots WHERE resource=%s AND mode=%s",
                    (resource, self.mode),
                ).fetchone()
                return _decode(row) if row is not None else None, _now(c)
        except (
            ValueError,
            TypeError,
            PersistenceUnavailable,
            AccessRejected,
            PoolClosed,
            PoolTimeout,
        ):
            raise PublicDataStoreError() from None

    def validate_payload(self, resource: PublicDataResource, payload: PublicDataPayload) -> None:
        _payload(resource, self.mode, payload)

    def save(
        self,
        resource: PublicDataResource,
        *,
        payload: PublicDataPayload,
        last_good: PublicDataPayload | None,
        fetched_at_ms: int,
        refresh_at_ms: int,
        expected_revision: int,
    ) -> StoredPublicData | None:
        t, repo = self.ticket, self.repository
        if t is None or resource != RESOURCES[t.scope] or type(expected_revision) is not int:
            raise PublicDataStoreError()
        s = _state(
            resource,
            self.mode,
            payload,
            last_good,
            fetched_at_ms,
            refresh_at_ms,
            expected_revision + 1,
        )
        with repo.pool.transaction(write=True, scope_id=repo._key(t.scope)) as c:
            b, _ = repo._owned(c, t)
            a = repo._attempt(c, t.request_id)
            if a is None or a["deadline_ms"] is None or a["deadline_ms"] < refresh_at_ms:
                raise PublicDataStoreError()
            row = c.execute(
                "SELECT revision FROM public_data.snapshots WHERE resource=%s AND mode=%s",
                (resource, self.mode),
            ).fetchone()
            if (row["revision"] if row else 0) != expected_revision:
                # A lost CAS is an unresolved operation, never a successful collection.
                raise PublicDataStoreError()
            c.execute(
                "INSERT INTO public_data.snapshots "
                "(resource,mode,revision,fetched_at_ms,refresh_at_ms,"
                "payload_json,last_good_json) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(resource,mode) DO UPDATE SET "
                "revision=excluded.revision,fetched_at_ms=excluded.fetched_at_ms,"
                "refresh_at_ms=excluded.refresh_at_ms,payload_json=excluded.payload_json,"
                "last_good_json=excluded.last_good_json",
                (
                    resource,
                    self.mode,
                    s.revision,
                    fetched_at_ms,
                    refresh_at_ms,
                    s.payload.model_dump_json(),
                    s.last_good.model_dump_json() if s.last_good else None,
                ),
            )
            c.execute(
                "UPDATE public_data.attempts SET state='COMPLETED',revision=%s "
                "WHERE request_id=%s AND mode=%s",
                (s.revision, t.request_id, self.mode),
            )
            c.execute(
                "UPDATE public_data.budgets SET active_request=NULL,next_at_ms=%s "
                "WHERE scope=%s AND mode=%s",
                (a["deadline_ms"], t.scope, self.mode),
            )
        return s
