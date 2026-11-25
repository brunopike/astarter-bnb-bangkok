"""Transactional finite simulation risk service; native facts are never caller scalars."""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import asdict
from fractions import Fraction as F
from hashlib import sha256
from typing import Any, cast
from uuid import uuid4

from stark_trading_os.control.astarter.transaction_service import (
    LEASE_EVENT,
    AdmissionAccess,
    BackendAdmissionSource,
    BackendControllerSource,
    ControllerAccess,
    ControllerIdentity,
)
from stark_trading_os.control.database import _immediate_transaction, verify_control_connection
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain import astarter_risk as risk
from stark_trading_os.domain.astarter_simulation import (
    TERMINAL,
    AccountRiskState,
    AstarterBlocked,
    AstarterConflict,
    AstarterIntegrityError,
    NativeFill,
    NativeOrder,
    NativeSnapshot,
    Opportunity,
    OrderCommand,
    OrderState,
    Reservation,
    Settlement,
    SimulationPolicy,
    amount,
    digest,
    encode,
    policy_bytes,
    text,
    validate_opportunity,
)
from stark_trading_os.domain.s03_bridge import S03_FINITE_AUTHORITY, S03Owner, s03_quote_clock
from stark_trading_os.runner.astarter_facts import NativeFactsSource


def _decode(raw: bytes) -> Any:
    value = json.loads(raw)
    if encode(value) != raw:
        raise AstarterIntegrityError("ASTARTER_STORED_BYTES_NONCANONICAL")
    return value


def _policy(raw: bytes) -> SimulationPolicy:
    value = _decode(raw)
    value["caps"] = tuple(value["caps"])
    policy = SimulationPolicy(**value)
    if policy_bytes(policy) != raw:
        raise AstarterIntegrityError("ASTARTER_POLICY_CORRUPT")
    return policy


def _snapshot(raw: bytes) -> NativeSnapshot:
    value = _decode(raw)["snapshot"]
    value["orders"] = tuple(NativeOrder(**v) for v in value["orders"])
    value["fills"] = tuple(NativeFill(**v) for v in value["fills"])
    return NativeSnapshot(**value)


def _ceil(value: F, unit: F) -> F:
    return -((-value) // unit) * unit


class AstarterControl:
    def __init__(
        self, store: ControlStore, *, backend: BackendControllerSource | None = None,
        admission_backend: BackendAdmissionSource | None = None,
    ) -> None:
        if type(store) is not ControlStore:
            raise TypeError("Astarter requires the existing exact ControlStore")
        verify_control_connection(store._connection)
        self._store, self._c = store, store._connection
        self._access = ControllerAccess(self._c, backend)
        self._admission = AdmissionAccess(self._c, admission_backend)

    @property
    def controller_identity(self) -> ControllerIdentity:
        return self._access.required()

    def _writer(self, account_id: str) -> None:
        row = self._row(account_id)
        self._access.writer(account_id, row["controller_fence"])

    def _row(self, account_id: str) -> sqlite3.Row:
        self._access.scope(account_id)
        row = self._c.execute(
            "SELECT * FROM astarter_accounts WHERE account_id=?", (account_id,)
        ).fetchone()
        if row is None:
            raise AstarterBlocked("ASTARTER_ACCOUNT_NOT_FOUND")
        return cast(sqlite3.Row, row)

    def _audit(self, account_id: str, kind: str, fact: object) -> None:
        seq = self._c.execute(
            "SELECT COALESCE(MAX(seq),0)+1 FROM astarter_audit WHERE account_id=?", (account_id,)
        ).fetchone()[0]
        raw = encode(fact)
        self._c.execute(
            "INSERT INTO astarter_audit VALUES(?,?,?,?,?)",
            (account_id, seq, kind, raw, sha256(raw).hexdigest()),
        )

    def _bump(self, account_id: str) -> None:
        self._c.execute(
            "UPDATE astarter_accounts SET risk_epoch=risk_epoch+1 WHERE account_id=?", (account_id,)
        )

    def _locks(self, row: sqlite3.Row) -> set[str]:
        values = _decode(row["hard_locks"])
        if type(values) is not list or any(type(v) is not str for v in values):
            raise AstarterIntegrityError("ASTARTER_LOCK_STATE_INVALID")
        return set(values)

    def _set_locks(self, account_id: str, locks: set[str]) -> None:
        self._c.execute(
            "UPDATE astarter_accounts SET hard_locks=? WHERE account_id=?",
            (encode(sorted(locks)), account_id),
        )

    def _view(self, account_id: str) -> AccountRiskState:
        row = self._row(account_id)
        intents = self._c.execute(
            "SELECT pending_risk,inventory_risk,cash_hold FROM astarter_intents WHERE account_id=?",
            (account_id,),
        ).fetchall()
        totals = [
            sum((amount(v[k]) for v in intents), F(0))
            for k in ("pending_risk", "inventory_risk", "cash_hold")
        ]
        return AccountRiskState(
            account_id,
            row["risk_epoch"],
            row["controller_fence"],
            tuple(sorted(self._locks(row))),
            row["risk_period"],
            row["last_sequence"],
            text(totals[0]),
            text(totals[1]),
            text(totals[2]),
            row["profit_hwm"],
            row["locked_reserve"],
        )

    def account(self, account_id: str) -> AccountRiskState:
        # One read snapshot; reserve still independently rereads everything under CAS.
        self._c.execute("BEGIN")
        try:
            return self._view(account_id)
        finally:
            self._c.rollback()

    def activate(
        self, source: NativeFactsSource, policy: SimulationPolicy, *, component_id: str
    ) -> str:
        raw = policy_bytes(policy)
        if type(component_id) is not str or re.fullmatch(r"[0-9a-f]{64}", component_id) is None:
            raise ValueError("ASTARTER_COMPONENT_INVALID")
        if type(source) is not NativeFactsSource:
            raise AstarterIntegrityError("ASTARTER_SOURCE_REQUIRED")
        self._access.check_source(source.account_id, source.venue_session)
        snap = source.capture()
        source.verify(snap)
        with _immediate_transaction(self._c):
            source.verify(snap)
            row = self._c.execute(
                "SELECT * FROM astarter_accounts WHERE account_id=?", (snap.account_id,)
            ).fetchone()
            if row is None:
                if (
                    not snap.cash_reconciled
                    or snap.orders
                    or snap.fills
                    or amount(snap.base_total) != 0
                ):
                    raise AstarterIntegrityError("ASTARTER_NATIVE_INITIAL_BASELINE_INVALID")
                self._c.execute(
                    (
                        "INSERT INTO astarter_accounts(account_id,venue_session,baseline_quote,"
                        "risk_period,lock_fraction) VALUES(?,?,?,?,?)"
                    ),
                    (
                        snap.account_id,
                        snap.venue_session,
                        source.initial_quote,
                        str(uuid4()),
                        policy.lock_fraction,
                    ),
                )
                for scope, cap in zip(risk.BUDGET_SCOPES, policy.caps, strict=True):
                    self._c.execute(
                        "INSERT INTO astarter_limits(account_id,scope,cap) VALUES(?,?,?)",
                        (snap.account_id, scope, cap),
                    )
                self._access.establish_new_account(snap.account_id, snap.venue_session)
                self._admission.establish(self.controller_identity)
                self._audit(snap.account_id, LEASE_EVENT, self._access.lease_fact())
            elif (
                row["venue_session"] != snap.venue_session
                or row["baseline_quote"] != source.initial_quote
            ):
                raise AstarterIntegrityError("ASTARTER_ACCOUNT_SOURCE_CONFLICT")
            self._writer(snap.account_id)
            self._admission.head(self.controller_identity)
            self._reject_s03_lease(snap.account_id)
            caps = {
                v["scope"]: v["cap"]
                for v in self._c.execute(
                    "SELECT * FROM astarter_limits WHERE account_id=?", (snap.account_id,)
                )
            }
            if tuple(caps[k] for k in risk.BUDGET_SCOPES) != policy.caps:
                raise AstarterConflict("ASTARTER_ACCOUNT_LIMITS_CANNOT_RESET")
            if self._row(snap.account_id)["lock_fraction"] != policy.lock_fraction:
                raise AstarterConflict("ASTARTER_ACCOUNT_LOCK_FRACTION_CANNOT_RESET")
            self._observe_locked(snap)
            previous = self._c.execute(
                (
                    "SELECT binding_id FROM astarter_bindings WHERE account_id=? AND "
                    "component_id=? AND policy_sha256=?"
                ),
                (snap.account_id, component_id, sha256(raw).hexdigest()),
            ).fetchone()
            if previous is not None:
                status = self._c.execute(
                    ("SELECT status FROM astarter_bindings WHERE binding_id=?"), (previous[0],)
                ).fetchone()[0]
                if status != "ACTIVE":
                    raise AstarterBlocked("ASTARTER_BINDING_REVOKED_REVIEW_REQUIRED")
                return str(previous[0])
            key = str(uuid4())
            self._c.execute(
                "INSERT INTO astarter_bindings VALUES(?,?,?,?,?,'ACTIVE')",
                (key, snap.account_id, component_id, raw, sha256(raw).hexdigest()),
            )
            self._audit(
                snap.account_id,
                "BINDING_ACTIVATED",
                dict(
                    binding_id=key, component_id=component_id, policy_sha256=sha256(raw).hexdigest()
                ),
            )
            self._bump(snap.account_id)
            return key

    def _binding(
        self, binding_id: str, *, require_active: bool = True
    ) -> tuple[sqlite3.Row, SimulationPolicy]:
        row = self._c.execute(
            "SELECT * FROM astarter_bindings WHERE binding_id=?", (binding_id,)
        ).fetchone()
        if row is None or (require_active and row["status"] != "ACTIVE"):
            raise AstarterBlocked("ASTARTER_BINDING_INACTIVE")
        self._access.scope(row["account_id"])
        if sha256(row["policy_bytes"]).hexdigest() != row["policy_sha256"]:
            raise AstarterIntegrityError("ASTARTER_POLICY_CORRUPT")
        return row, _policy(row["policy_bytes"])

    def revoke(self, binding_id: str, *, owner: object | None = None) -> None:
        with _immediate_transaction(self._c):
            row, _ = self._binding(binding_id, require_active=False)
            self._reject_s03_lease(str(row["account_id"]), owner)
            if row["status"] == "REVOKED":
                return
            self._c.execute(
                ("UPDATE astarter_bindings SET status='REVOKED' WHERE binding_id=?"), (binding_id,)
            )
            self._audit(row["account_id"], "BINDING_REVOKED", dict(binding_id=binding_id))
            self._bump(row["account_id"])

    def refresh_admission(self) -> str:
        """Publish backend-selected state, never a caller-supplied approval DTO."""
        update = self._admission.update_outside_transaction()
        with _immediate_transaction(self._c):
            identity = self.controller_identity
            self._writer(identity.assignment.binding.account_id)
            before = self._admission.head(identity)["generation"]
            result = self._admission.publish(identity, update)
            if self._admission.head(identity)["generation"] != before:
                self._audit(identity.assignment.binding.account_id, "D2_ADMISSION_CHANGED",
                            dict(admission_id=result, generation=before + 1))
                self._bump(identity.assignment.binding.account_id)
            return result

    def _admission_now(self) -> int:
        now_ns = self._store._clock()
        if type(now_ns) is not int or not 0 <= now_ns < 2**63:
            raise AstarterBlocked("ASTARTER_ADMISSION_CLOCK_INVALID")
        return now_ns // 1_000_000

    def _minimum_ttl(self, intents: list[sqlite3.Row]) -> int:
        if not intents:
            raise AstarterIntegrityError("ASTARTER_TTL_PARTICIPANTS_REQUIRED")
        # Immutable economic intents participate, even if their binding was
        # revoked. A wider or unused alias cannot relax an earlier plan.
        return min(
            self._binding(i["binding_id"], require_active=False)[1].snapshot_ttl_ns for i in intents
        )

    def _latest(self, row: sqlite3.Row, ttl_ns: int) -> NativeSnapshot:
        raw = row["last_snapshot"]
        if raw is None or sha256(raw).hexdigest() != row["last_snapshot_sha256"]:
            raise AstarterBlocked("ASTARTER_NATIVE_SNAPSHOT_MISSING")
        wrapper = _decode(raw)
        age = self._store._clock() - wrapper["observed_wall_ns"]
        snap = _snapshot(raw)
        event_now = self._action_time_ns(str(row["account_id"]), snap.now_ns)
        leased = self._c.execute(
            "SELECT 1 FROM s03_runs WHERE account_id=? AND status='ACTIVE'", (row["account_id"],)
        ).fetchone()
        if leased is not None:
            if not s03_quote_clock(snap, event_now):
                raise AstarterBlocked("ASTARTER_S03_QUOTE_CLOCK")
            from stark_trading_os.control.s03_bridge import S03BridgeControl

            run = self._c.execute(
                "SELECT run_id FROM s03_runs WHERE account_id=? AND status='ACTIVE'",
                (row["account_id"],),
            ).fetchone()
            S03BridgeControl(self._store, control=self)._qualify_quote_locked(str(run[0]), snap)
        if (
            age < 0
            or age >= ttl_ns
            or snap.now_ns < snap.quote_time_ns
            or event_now - snap.quote_time_ns >= ttl_ns
        ):
            raise AstarterBlocked("ASTARTER_NATIVE_SNAPSHOT_STALE")
        if snap.venue_session != row["venue_session"] or snap.sequence != row["last_sequence"]:
            raise AstarterIntegrityError("ASTARTER_NATIVE_SNAPSHOT_CONFLICT")
        return snap

    def reserve(
        self,
        binding_id: str,
        opportunity: Opportunity,
        *,
        expected_epoch: int,
        expected_sequence: int,
        fence: int,
        admission_id: str | None = None,
    ) -> Reservation:
        with _immediate_transaction(self._c):
            self._reject_s03_lease_for_binding(binding_id)
            return self._reserve_locked(
                binding_id,
                opportunity,
                expected_epoch=expected_epoch,
                expected_sequence=expected_sequence,
                fence=fence,
                admission_id=admission_id,
            )

    def claim_order(
        self,
        order_id: str,
        *,
        fence: int,
        owner: object | None = None,
        source: NativeFactsSource | None = None,
    ) -> OrderCommand | None:
        with _immediate_transaction(self._c):
            order = self._c.execute(
                "SELECT account_id,role FROM astarter_orders WHERE order_id=?", (order_id,)
            ).fetchone()
            if order is not None and order["role"] == "ENTRY":
                self._reject_s03_entry(str(order["account_id"]))
            if order is not None:
                self._refresh_s03_action_locked(str(order["account_id"]), owner, source)
            return self._claim_order_locked(order_id, fence=fence, owner=owner)

    def halt(self, account_id: str, reason: str, *, owner: object | None = None) -> None:
        if reason not in {
            "DAY_LOSS",
            "RISK_PERIOD_EXHAUSTED",
            "DRAWDOWN",
            "PROTECTION_FAILED",
            "NATIVE_INTEGRITY",
        }:
            raise ValueError("ASTARTER_HALT_REASON_INVALID")
        with _immediate_transaction(self._c):
            self._reject_s03_lease(account_id, owner)
            locks = self._locks(self._row(account_id)) | {reason}
            self._set_locks(account_id, locks)
            self._audit(account_id, "HARD_HALT", dict(reason=reason))
            self._bump(account_id)

    def begin_recovery(self, account_id: str, *, owner: object | None = None) -> AccountRiskState:
        with _immediate_transaction(self._c):
            self._reject_s03_lease(account_id, owner)
            if type(owner) is S03Owner:
                from stark_trading_os.control.s03_bridge import S03BridgeControl

                S03BridgeControl(self._store, control=self)._note_recovery_locked(owner)
            row = self._row(account_id)
            self._writer(account_id)
            self._set_locks(account_id, self._locks(row) | {"RECONCILE_REQUIRED"})
            self._c.execute(
                (
                    "UPDATE astarter_accounts SET controller_fence=controller_fence+1,"
                    "risk_epoch=risk_epoch+1 WHERE account_id=?"
                ),
                (account_id,),
            )
            self._c.execute(
                (
                    "UPDATE astarter_intents SET state='RECONCILING' WHERE account_id=? AND "
                    "state IN ('RESERVED','DISPATCHING')"
                ),
                (account_id,),
            )
            self._audit(
                account_id,
                "CONTROLLER_RECOVERY_STARTED",
                dict(previous_fence=row["controller_fence"]),
            )
            self._audit(
                account_id, LEASE_EVENT,
                self._access.lease_fact(fence=row["controller_fence"] + 1),
            )
            result = self._view(account_id)
        # A failed SQLite COMMIT must not advance the in-memory owner token.
        self._access.advance_after_commit()
        return result

    def observe(
        self,
        source: NativeFactsSource,
        snapshot: NativeSnapshot | None = None,
        *,
        owner: object | None = None,
    ) -> AccountRiskState:
        if type(source) is not NativeFactsSource:
            raise AstarterIntegrityError("ASTARTER_SOURCE_REQUIRED")
        self._access.check_source(source.account_id, source.venue_session)
        snap = source.capture() if snapshot is None else snapshot
        source.verify(snap)
        with _immediate_transaction(self._c):
            self._reject_s03_lease(snap.account_id, owner)
            source.verify(snap)
            self._observe_locked(snap)
            return self._view(snap.account_id)

    def _debit(self, account_id: str, delta: F) -> None:
        # Persistent period debit is closed negative net PnL only. Profits never
        # refill historical loss budgets; paid costs on open intents are separate.
        for row in self._c.execute(
            "SELECT * FROM astarter_limits WHERE account_id=?", (account_id,)
        ).fetchall():
            self._c.execute(
                "UPDATE astarter_limits SET booked_debit=? WHERE account_id=? AND scope=?",
                (text(amount(row["booked_debit"]) + delta), account_id, row["scope"]),
            )

    def _open_cost_debit(self, account_id: str) -> F:
        # Inventory risk starts at current bid. Preserve the already incurred
        # adverse move and paid fees too, until final native settlement replaces
        # this provision with exact closed negative net PnL atomically.
        intents = self._c.execute(
            "SELECT * FROM astarter_intents "
            "WHERE account_id=? AND state NOT IN ('CLOSED','NO_FILL')",
            (account_id,),
        ).fetchall()
        if not intents:
            return F(0)
        mark = amount(self._latest(self._row(account_id), self._minimum_ttl(intents)).bid)
        total = F(0)
        for row in intents:
            fills = self._intent_fills(row[0])
            cash_cost = F(0)
            inventory = F(0)
            fees = F(0)
            for fill in fills:
                sign = 1 if fill.side == "BUY" else -1
                inventory += sign * amount(fill.quantity)
                cash_cost += sign * amount(fill.quantity) * amount(fill.price)
                fees += amount(fill.fee)
            total += fees + max(F(0), cash_cost - inventory * mark)
        return total

    def _latch_period_limits(self, account_id: str, locks: set[str]) -> None:
        for limit in self._c.execute(
            "SELECT * FROM astarter_limits WHERE account_id=?", (account_id,)
        ):
            if amount(limit["booked_debit"]) >= amount(limit["cap"]):
                if limit["scope"] == "DAY":
                    locks.add("DAY_LOSS")
                if limit["scope"] == "CYCLE":
                    locks.add("RISK_PERIOD_EXHAUSTED")

    def _observe_locked(self, snap: NativeSnapshot) -> None:
        self._writer(snap.account_id)
        row = self._row(snap.account_id)
        if snap.venue_session != row["venue_session"]:
            raise AstarterIntegrityError("ASTARTER_ACCOUNT_SOURCE_CONFLICT")
        if snap.sequence <= row["last_sequence"]:
            raise AstarterConflict("ASTARTER_NATIVE_SEQUENCE_CONFLICT")
        known = {
            v["order_id"]: v
            for v in self._c.execute(
                "SELECT * FROM astarter_orders WHERE account_id=?", (snap.account_id,)
            )
        }
        native = {v.order_id: v for v in snap.orders}
        locks = self._locks(row)
        for fact in snap.orders:
            if fact.order_id not in known:
                raise AstarterIntegrityError("ASTARTER_NATIVE_UNOWNED_ORDER")
            prior = known[fact.order_id]
            if (
                amount(fact.quantity) != amount(prior["quantity"])
                or amount(fact.filled) > amount(fact.quantity)
                or fact.side != ("BUY" if prior["role"] == "ENTRY" else "SELL")
                or prior["dispatch_state"] in {"PENDING", "CANCELED_LOCAL"}
            ):
                raise AstarterIntegrityError("ASTARTER_NATIVE_ORDER_CONFLICT")
            intent = self._c.execute(
                "SELECT * FROM astarter_intents WHERE intent_id=?", (prior["intent_id"],)
            ).fetchone()
            receipt = Reservation(**_decode(intent["receipt_bytes"]))
            if prior["role"] == "ENTRY" and (
                fact.order_type != "LIMIT" or fact.limit_price != receipt.cap
            ):
                raise AstarterIntegrityError("ASTARTER_NATIVE_ENTRY_CONFLICT")
            if prior["role"] == "EXIT" and fact.order_type != "MARKET":
                raise AstarterIntegrityError("ASTARTER_NATIVE_EXIT_CONFLICT")
            if prior["role"] == "STOP":
                if fact.order_type != "STOP_MARKET" or fact.trigger_price != prior["trigger_price"]:
                    raise AstarterIntegrityError("ASTARTER_NATIVE_PROTECTION_CONFLICT")
                if (
                    fact.state in {"REJECTED", "DENIED", "EXPIRED"}
                    or (
                        fact.state == "CANCELED"
                        and not prior["cancel_requested"]
                        and intent["state"] != "CLOSING"
                    )
                    or (fact.accepted_at_ns is None and snap.now_ns > prior["deadline_ns"])
                    or (
                        fact.accepted_at_ns is not None
                        and fact.accepted_at_ns > prior["deadline_ns"]
                    )
                ):
                    locks.add("PROTECTION_FAILED")
            self._c.execute(
                (
                    "UPDATE astarter_orders SET native_state=?,dispatch_state='OBSERVED',"
                    "accepted_at_ns=?,last_sequence=? WHERE order_id=?"
                ),
                (fact.state, fact.accepted_at_ns, snap.sequence, fact.order_id),
            )
            if prior["native_state"] != fact.state:
                self._audit(snap.account_id, "NATIVE_ORDER_STATE", asdict(fact))
        native_keys = {(v.order_id, v.trade_id) for v in snap.fills}
        stored = self._c.execute(
            "SELECT * FROM astarter_fills WHERE account_id=?", (snap.account_id,)
        ).fetchall()
        if any((v["order_id"], v["trade_id"]) not in native_keys for v in stored):
            raise AstarterIntegrityError("ASTARTER_NATIVE_FILL_HISTORY_MISSING")
        for fill in snap.fills:
            if (
                fill.order_id not in known
                or fill.currency != "USDT"
                or amount(fill.quantity) <= 0
                or amount(fill.price) <= 0
            ):
                raise AstarterIntegrityError("ASTARTER_NATIVE_FILL_UNOWNED")
            raw = encode(asdict(fill))
            hashed = sha256(raw).hexdigest()
            old = self._c.execute(
                (
                    "SELECT fact_sha256 FROM astarter_fills WHERE account_id=? AND order_id=? "
                    "AND trade_id=?"
                ),
                (snap.account_id, fill.order_id, fill.trade_id),
            ).fetchone()
            if old is not None:
                if old[0] != hashed:
                    raise AstarterIntegrityError("ASTARTER_NATIVE_FILL_CONFLICT")
            else:
                self._c.execute(
                    "INSERT INTO astarter_fills VALUES(?,?,?,?,?)",
                    (snap.account_id, fill.order_id, fill.trade_id, raw, hashed),
                )
                self._audit(snap.account_id, "NATIVE_FILL", asdict(fill))
        for fact in snap.orders:
            qty = sum((amount(v.quantity) for v in snap.fills if v.order_id == fact.order_id), F(0))
            if qty != amount(fact.filled):
                raise AstarterIntegrityError("ASTARTER_NATIVE_FILL_COVERAGE_MISMATCH")
        missing = any(
            v["dispatch_state"] in {"DISPATCHING", "OBSERVED"} and key not in native
            for key, v in known.items()
        )
        missing = missing or any(
            v["cancel_requested"] and (key not in native or native[key].state not in TERMINAL)
            for key, v in known.items()
        )
        for key, v in known.items():
            if (
                v["role"] == "STOP"
                and v["dispatch_state"] != "CANCELED_LOCAL"
                and v["native_state"] not in TERMINAL
                and v["accepted_at_ns"] is None
                and snap.now_ns > v["deadline_ns"]
                and (key not in native or native[key].accepted_at_ns is None)
            ):
                locks.add("PROTECTION_FAILED")
        if not snap.cash_reconciled or missing:
            locks.add("RECONCILE_REQUIRED")
        else:
            locks.discard("RECONCILE_REQUIRED")
        for intent in self._c.execute(
            (
                "SELECT * FROM astarter_intents WHERE account_id=? AND state NOT IN "
                "('CLOSED','NO_FILL')"
            ),
            (snap.account_id,),
        ).fetchall():
            self._refresh_intent(intent, snap, native)
        self._latch_period_limits(snap.account_id, locks)
        locks.discard("PROTECTION_PENDING")
        locks.discard("EXIT_PENDING")
        for active in self._c.execute(
            (
                "SELECT * FROM astarter_intents WHERE account_id=? AND state NOT IN "
                "('CLOSED','NO_FILL')"
            ),
            (snap.account_id,),
        ).fetchall():
            q = self._inventory(active["intent_id"])
            if active["state"] == "CLOSING" and (q > 0 or amount(active["pending_risk"]) > 0):
                locks.add("EXIT_PENDING")
                continue
            accepted = self._accepted_protection(active["intent_id"], snap)
            if q > accepted:
                locks.add("PROTECTION_PENDING")
        if locks != self._locks(row):
            self._audit(snap.account_id, "RISK_LOCKS_CHANGED", dict(locks=sorted(locks)))
        self._set_locks(snap.account_id, locks)
        raw = encode(dict(snapshot=asdict(snap), observed_wall_ns=self._store._clock()))
        self._c.execute(
            (
                "UPDATE astarter_accounts SET last_sequence=?,last_snapshot=?,"
                "last_snapshot_sha256=?,risk_epoch=risk_epoch+1 WHERE account_id=?"
            ),
            (snap.sequence, raw, sha256(raw).hexdigest(), snap.account_id),
        )
        run = self._c.execute(
            "SELECT run_id FROM s03_runs WHERE account_id=? AND status='ACTIVE'", (snap.account_id,)
        ).fetchone()
        if run is not None:
            from stark_trading_os.control.s03_bridge import S03BridgeControl

            S03BridgeControl(self._store, control=self)._observe_native_life_locked(
                str(run[0]), snap
            )

    def _refresh_intent(
        self, intent: sqlite3.Row, snap: NativeSnapshot, native: dict[str, NativeOrder]
    ) -> None:
        _, policy = self._binding(intent["binding_id"], require_active=False)
        receipt = Reservation(**_decode(intent["receipt_bytes"]))
        ids = {
            v[0]
            for v in self._c.execute(
                "SELECT order_id FROM astarter_orders WHERE intent_id=?", (intent["intent_id"],)
            )
        }
        fills = [v for v in snap.fills if v.order_id in ids]
        bought = sum((amount(v.quantity) for v in fills if v.side == "BUY"), F(0))
        sold = sum((amount(v.quantity) for v in fills if v.side == "SELL"), F(0))
        if sold > bought:
            raise AstarterIntegrityError("ASTARTER_NATIVE_OVERSELL")
        entry = native.get(receipt.entry_order_id)
        remaining = (
            F(0)
            if entry is not None and entry.state in TERMINAL
            else amount(receipt.quantity) - bought
        )
        unit = amount(policy.quote_unit)
        pending = _ceil(amount(receipt.risk_reserved) * remaining / amount(receipt.quantity), unit)
        cash = (
            F(0)
            if remaining == 0
            else amount(risk.spot_costs(policy.profile(), text(remaining)).reserve)
        )
        inventory = bought - sold
        future = inventory * max(F(0), amount(snap.bid) - amount(policy.stress))
        if inventory > 0:
            future += (
                _ceil(inventory * amount(policy.stress) * amount(policy.fee), unit)
                + (inventory / amount(policy.step)) * unit
            )
        state = intent["state"]
        if entry is not None and entry.state in TERMINAL and bought == 0:
            state = "NO_FILL"
        elif bought > 0 and state not in {"CLOSING", "RECONCILING"}:
            state = "ACTIVE"
        elif state == "RECONCILING" and entry is not None:
            state = "ACTIVE" if bought > 0 else state
        self._c.execute(
            (
                "UPDATE astarter_intents SET state=?,pending_risk=?,inventory_risk=?,"
                "cash_hold=? WHERE intent_id=?"
            ),
            (state, text(pending), text(future), text(cash), intent["intent_id"]),
        )

    def reservations(self, account_id: str) -> tuple[Reservation, ...]:
        self._access.scope(account_id)
        return tuple(
            Reservation(**_decode(v[0]))
            for v in self._c.execute(
                "SELECT receipt_bytes FROM astarter_intents WHERE account_id=? ORDER BY rowid",
                (account_id,),
            )
        )

    def orders(self, intent_id: str) -> tuple[OrderState, ...]:
        self._intent(intent_id)
        return tuple(
            OrderState(
                v["order_id"],
                v["intent_id"],
                v["role"],
                v["quantity"],
                v["native_state"],
                v["dispatch_state"],
                bool(v["cancel_requested"]),
                v["accepted_at_ns"],
                v["deadline_ns"],
            )
            for v in self._c.execute(
                "SELECT * FROM astarter_orders WHERE intent_id=? ORDER BY order_id", (intent_id,)
            )
        )

    def _intent(self, intent_id: str) -> sqlite3.Row:
        row = self._c.execute(
            "SELECT * FROM astarter_intents WHERE intent_id=?", (intent_id,)
        ).fetchone()
        if row is None:
            raise AstarterBlocked("ASTARTER_INTENT_NOT_FOUND")
        self._access.scope(row["account_id"])
        return cast(sqlite3.Row, row)

    def _intent_fills(self, intent_id: str) -> tuple[NativeFill, ...]:
        rows = self._c.execute(
            (
                "SELECT f.fact_bytes,f.fact_sha256 FROM astarter_fills f JOIN "
                "astarter_orders o ON o.order_id=f.order_id WHERE o.intent_id=?"
            ),
            (intent_id,),
        ).fetchall()
        result = []
        for row in rows:
            if sha256(row[0]).hexdigest() != row[1]:
                raise AstarterIntegrityError("ASTARTER_FILL_CORRUPT")
            result.append(NativeFill(**_decode(row[0])))
        return tuple(result)

    def _inventory(self, intent_id: str) -> F:
        fills = self._intent_fills(intent_id)
        return sum((amount(v.quantity) * (1 if v.side == "BUY" else -1) for v in fills), F(0))

    def prepare_protection(
        self, intent_id: str, *, owner: object | None = None
    ) -> OrderCommand | None:
        with _immediate_transaction(self._c):
            intent = self._intent(intent_id)
            self._reject_s03_lease(str(intent["account_id"]), owner)
            _, policy = self._binding(intent["binding_id"], require_active=False)
            row = self._row(intent["account_id"])
            snap = self._latest(row, policy.snapshot_ttl_ns)
            orders = self.orders(intent_id)
            if "PROTECTION_FAILED" in self._locks(row) or (
                intent["state"] == "CLOSING"
                and any(o.role == "ENTRY" and o.native_state in TERMINAL for o in orders)
            ):
                return None
            for order in orders:
                if order.role == "STOP" and order.dispatch_state == "PENDING":
                    # Resume the existing never-claimed command, preserving the
                    # original fill-based deadline and deterministic native ID.
                    if order.deadline_ns is not None and snap.now_ns <= order.deadline_ns:
                        receipt = Reservation(**_decode(intent["receipt_bytes"]))
                        return OrderCommand(
                            order.order_id, intent_id, "STOP", order.quantity, receipt.stop
                        )
                    return None
            inventory = self._inventory(intent_id)
            sold = {
                o.order_id: sum(
                    (amount(v.quantity) for v in snap.fills if v.order_id == o.order_id), F(0)
                )
                for o in orders
            }
            covered = sum(
                (
                    amount(o.quantity) - sold[o.order_id]
                    for o in orders
                    if o.role in {"STOP", "EXIT"}
                    and o.native_state not in TERMINAL
                    and o.dispatch_state != "CANCELED_LOCAL"
                ),
                F(0),
            )
            q = inventory - covered
            if q <= 0:
                return None
            # Assign previously sold/covered quantities FIFO to actual buy fills.
            # A recovery cannot restart an old fill's protection acceptance window.
            unprotected_at = self._uncovered_fill_time(intent_id, covered)
            if unprotected_at is None:
                raise AstarterIntegrityError("ASTARTER_PROTECTION_FILL_COVERAGE_INVALID")
            deadline = unprotected_at + policy.protection_timeout_ns
            if snap.now_ns > deadline:
                self._set_locks(intent["account_id"], self._locks(row) | {"PROTECTION_FAILED"})
                self._audit(
                    intent["account_id"],
                    "PROTECTION_DEADLINE_ALREADY_EXPIRED",
                    dict(intent_id=intent_id, fill_time_ns=unprotected_at, deadline_ns=deadline),
                )
                self._bump(intent["account_id"])
                return None
            receipt = Reservation(**_decode(intent["receipt_bytes"]))
            ordinal = 1 + sum(o.role == "STOP" for o in orders)
            key = receipt.entry_order_id[:-1] + f"P{ordinal}"
            self._c.execute(
                (
                    "INSERT INTO astarter_orders(order_id,account_id,intent_id,role,quantity,"
                    "trigger_price,deadline_ns) VALUES(?,?,?,'STOP',?,?,?)"
                ),
                (
                    key,
                    intent["account_id"],
                    intent_id,
                    text(q),
                    receipt.stop,
                    deadline,
                ),
            )
            self._audit(
                intent["account_id"],
                "PROTECTION_INTENT",
                dict(
                    order_id=key,
                    quantity=text(q),
                    deadline_ns=deadline,
                ),
            )
            self._bump(intent["account_id"])
            return OrderCommand(key, intent_id, "STOP", text(q), receipt.stop)

    def request_exit(self, intent_id: str, *, owner: object | None = None) -> None:
        with _immediate_transaction(self._c):
            self._request_exit_locked(intent_id, owner)

    def claim_cancel(
        self,
        order_id: str,
        *,
        fence: int,
        owner: object | None = None,
        source: NativeFactsSource | None = None,
    ) -> bool:
        with _immediate_transaction(self._c):
            order = self._c.execute(
                "SELECT * FROM astarter_orders WHERE order_id=?", (order_id,)
            ).fetchone()
            if order is None:
                raise AstarterBlocked("ASTARTER_ORDER_NOT_FOUND")
            self._refresh_s03_action_locked(str(order["account_id"]), owner, source)
            order = self._c.execute(
                "SELECT * FROM astarter_orders WHERE order_id=?", (order_id,)
            ).fetchone()
            account = self._row(order["account_id"])
            self._reject_s03_lease(str(account["account_id"]), owner)
            if type(fence) is not int or fence != account["controller_fence"]:
                raise AstarterConflict("ASTARTER_CONTROLLER_FENCED")
            intent = self._intent(order["intent_id"])
            _, policy = self._binding(intent["binding_id"], require_active=False)
            s03_target = self._s03_exit_target(str(order["intent_id"]))
            if s03_target is False and order["role"] != "ENTRY":
                return False
            if (
                (
                    intent["state"] != "CLOSING"
                    and not (s03_target is False and order["role"] == "ENTRY")
                )
                or order["role"] == "EXIT"
                or order["native_state"] in TERMINAL
                or order["cancel_requested"]
                or order["dispatch_state"] == "CANCELED_LOCAL"
            ):
                return False
            if order["dispatch_state"] == "PENDING":
                # This command provably never crossed the write-before-send claim.
                self._c.execute(
                    "UPDATE astarter_orders SET dispatch_state='CANCELED_LOCAL' WHERE order_id=?",
                    (order_id,),
                )
                if order["role"] == "ENTRY":
                    self._c.execute(
                        "UPDATE astarter_intents SET state='NO_FILL',pending_risk='0',"
                        "cash_hold='0' WHERE intent_id=?",
                        (order["intent_id"],),
                    )
                self._audit(
                    order["account_id"], "UNSENT_ORDER_CANCELED_LOCAL", dict(order_id=order_id)
                )
                self._bump(order["account_id"])
                return False
            snap = self._latest(account, policy.snapshot_ttl_ns)
            if (
                self._locks(account) & {"RECONCILE_REQUIRED", "NATIVE_INTEGRITY"}
                or not snap.cash_reconciled
            ):
                return False
            if not any(v.order_id == order_id for v in snap.orders):
                return False  # unknown dispatched order must be reconciled, not blindly canceled
            if order["role"] == "STOP":
                inventory = self._inventory(order["intent_id"])
                remaining = amount(order["quantity"]) - sum(
                    (amount(v.quantity) for v in snap.fills if v.order_id == order_id), F(0)
                )
                # Accepted protection may lock free base until cancellation.
                # Verify owned total inventory, not the post-cancel free balance.
                if (
                    remaining <= 0
                    or remaining > inventory
                    or amount(snap.base_total) < inventory
                    or amount(snap.position_quantity) < inventory
                ):
                    return False
            self._c.execute(
                "UPDATE astarter_orders SET cancel_requested=1 WHERE order_id=?", (order_id,)
            )
            self._audit(
                order["account_id"],
                "NATIVE_CANCEL_INTENT",
                dict(
                    order_id=order_id,
                    started_at_ns=snap.now_ns,
                    deadline_ns=snap.now_ns + 1_000_000_000,
                    operation="CANCEL",
                ),
            )
            self._bump(order["account_id"])
            return True

    def prepare_exit(
        self,
        intent_id: str,
        *,
        owner: object | None = None,
        allow_same_snapshot: bool = False,
    ) -> OrderCommand | None:
        with _immediate_transaction(self._c):
            self._reject_s03_lease(str(self._intent(intent_id)["account_id"]))
            return self._prepare_exit_locked(
                intent_id, owner, allow_same_snapshot=allow_same_snapshot
            )

    def settle(
        self,
        account_id: str,
        *,
        request_id: str,
        component_id: str | None = None,
        owner: object | None = None,
        source: NativeFactsSource | None = None,
    ) -> Settlement:
        # Client request/component aliases are trace labels, never economic identity.
        if type(request_id) is not str or not 1 <= len(request_id) <= 128:
            raise ValueError("ASTARTER_SETTLEMENT_REQUEST_INVALID")
        with _immediate_transaction(self._c):
            self._refresh_s03_action_locked(account_id, owner, source)
            row = self._row(account_id)
            intents = self._c.execute(
                "SELECT * FROM astarter_intents WHERE account_id=? ORDER BY rowid", (account_id,)
            ).fetchall()
            if not intents:
                raise AstarterBlocked("ASTARTER_SETTLEMENT_NO_NATIVE_OPPORTUNITY")
            # Settlement's cumulative native PnL/fill proof includes all history,
            # so even CLOSED/NO_FILL plans retain their original TTL constraint.
            snap = self._latest(row, self._minimum_ttl(intents))
            if (
                not snap.cash_reconciled
                or amount(snap.base_total) != 0
                or amount(snap.position_quantity) != 0
                or any(v.state not in TERMINAL for v in snap.orders)
            ):
                raise AstarterBlocked("ASTARTER_SETTLEMENT_NOT_RECONCILED")
            all_orders = [o for i in intents for o in self.orders(i["intent_id"])]
            if any(
                o.native_state not in TERMINAL and o.dispatch_state != "CANCELED_LOCAL"
                for o in all_orders
            ):
                raise AstarterBlocked("ASTARTER_SETTLEMENT_HAS_UNRESOLVED_ORDERS")
            if any(amount(i["pending_risk"]) > 0 or amount(i["cash_hold"]) > 0 for i in intents):
                raise AstarterBlocked("ASTARTER_SETTLEMENT_HAS_UNRESOLVED_RISK")
            fill_facts = [asdict(v) for v in snap.fills]
            economic = digest(
                dict(
                    account_id=account_id,
                    venue_session=snap.venue_session,
                    fills=[(v.order_id, v.trade_id) for v in snap.fills],
                )
            )
            stable_facts = dict(
                account_id=account_id,
                venue_session=snap.venue_session,
                fills=fill_facts,
                native_quote=snap.quote_total,
                native_base=snap.base_total,
            )
            fact_hash = digest(stable_facts)
            prior = self._c.execute(
                "SELECT * FROM astarter_settlements WHERE account_id=? AND economic_id=?",
                (account_id, economic),
            ).fetchone()
            net = amount(snap.quote_total) - amount(row["baseline_quote"])
            if prior is not None:
                if prior["fact_sha256"] != fact_hash:
                    raise AstarterIntegrityError("ASTARTER_SETTLEMENT_SOURCE_CONFLICT")
                return Settlement(
                    account_id,
                    economic,
                    False,
                    text(net),
                    "0",
                    row["locked_reserve"],
                    row["profit_hwm"],
                    snap.quote_total,
                    text(amount(snap.quote_total) - amount(row["locked_reserve"])),
                )
            locked = risk.profit_lock(
                risk.ProfitInput(
                    "USDT",
                    snap.quote_total,
                    text(net),
                    row["profit_hwm"],
                    row["locked_reserve"],
                    row["lock_fraction"],
                    True,
                    True,
                    True,
                )
            )
            for intent in intents:
                if intent["state"] in {"CLOSED", "NO_FILL"}:
                    continue
                fills = self._intent_fills(intent["intent_id"])
                buy = sum(
                    (amount(v.quantity) * amount(v.price) for v in fills if v.side == "BUY"), F(0)
                )
                sell = sum(
                    (amount(v.quantity) * amount(v.price) for v in fills if v.side == "SELL"), F(0)
                )
                fees = sum((amount(v.fee) for v in fills), F(0))
                self._debit(account_id, max(F(0), buy + fees - sell))
                self._c.execute(
                    (
                        "UPDATE astarter_intents SET state='CLOSED',pending_risk='0',"
                        "inventory_risk='0',cash_hold='0' WHERE intent_id=?"
                    ),
                    (intent["intent_id"],),
                )
            locks = self._locks(row)
            self._latch_period_limits(account_id, locks)
            if locks != self._locks(row):
                self._set_locks(account_id, locks)
                self._audit(account_id, "RISK_LOCKS_CHANGED", dict(locks=sorted(locks)))
            self._c.execute(
                "INSERT INTO astarter_settlements VALUES(?,?,?,?,?,?)",
                (
                    account_id,
                    economic,
                    fact_hash,
                    locked.increment,
                    locked.new_reserve,
                    encode(stable_facts),
                ),
            )
            self._c.execute(
                (
                    "UPDATE astarter_accounts SET profit_hwm=?,locked_reserve=?,"
                    "risk_epoch=risk_epoch+1 WHERE account_id=?"
                ),
                (locked.profit_hwm_after, locked.reserve_after, account_id),
            )
            self._audit(
                account_id,
                "NATIVE_SETTLEMENT_APPLIED",
                dict(
                    economic_id=economic,
                    net_profit=text(net),
                    new_lock=locked.new_reserve,
                    request_id=request_id,
                ),
            )
            return Settlement(
                account_id,
                economic,
                True,
                text(net),
                locked.new_reserve,
                locked.reserve_after,
                locked.profit_hwm_after,
                snap.quote_total,
                locked.tradable_equity,
            )

    def audit(self, account_id: str) -> tuple[dict[str, Any], ...]:
        self._access.scope(account_id)
        result = []
        for row in self._c.execute(
            "SELECT * FROM astarter_audit WHERE account_id=? ORDER BY seq", (account_id,)
        ):
            if sha256(row["fact_bytes"]).hexdigest() != row["fact_sha256"]:
                raise AstarterIntegrityError("ASTARTER_AUDIT_CORRUPT")
            result.append(dict(seq=row["seq"], kind=row["kind"], fact=_decode(row["fact_bytes"])))
        return tuple(result)

    def _action_time_ns(self, account_id: str, native_now_ns: int) -> int:
        timer = self._c.execute(
            "SELECT MAX(e.received_time_ns) FROM s03_events e JOIN s03_runs r ON r.run_id=e.run_id "
            "WHERE r.account_id=? AND r.status='ACTIVE' AND e.kind='TIMER'",
            (account_id,),
        ).fetchone()[0]
        return max(native_now_ns, timer or 0)

    def _reject_s03_lease_for_binding(self, binding_id: str) -> None:
        row = self._c.execute(
            "SELECT account_id FROM astarter_bindings WHERE binding_id=?",
            (binding_id,),
        ).fetchone()
        if row is not None:
            self._reject_s03_entry(str(row["account_id"]))

    def _reject_s03_lease(self, account_id: str, owner: Any | None = None) -> None:
        self._writer(account_id)
        row = self._c.execute(
            "SELECT * FROM s03_runs WHERE account_id=? AND status='ACTIVE'",
            (account_id,),
        ).fetchone()
        purpose = self._c.execute(
            "SELECT authority_id FROM astarter_admission_heads WHERE account_id=?", (account_id,)
        ).fetchone()
        if row is not None or (purpose is not None and purpose[0] == S03_FINITE_AUTHORITY):
            head = self._admission.head(self.controller_identity)
            if head["purpose"] != "LEGACY_FINITE" or head["authority_id"] != S03_FINITE_AUTHORITY:
                raise AstarterBlocked("ASTARTER_S03_AUTHORITY_REQUIRED")
        if row is None:
            return
        if owner is None or type(owner) is not S03Owner:
            raise AstarterBlocked("ASTARTER_S03_LEASE_HELD")
        credential = sha256(str(owner.credential).encode()).hexdigest()
        if (
            owner.run_id != row["run_id"]
            or owner.fence != int(row["fence"])
            or owner.owner_id != row["owner_id"]
            or owner.venue_session != row["venue_session"]
            or credential != row["credential_sha256"]
        ):
            raise AstarterBlocked("ASTARTER_S03_OWNER_STALE")

    def _reserve_locked(
        self,
        binding_id: str,
        opportunity: Opportunity,
        *,
        expected_epoch: int,
        expected_sequence: int,
        fence: int,
        admission_id: str | None = None,
        owner: object | None = None,
    ) -> Reservation:
        binding, policy = self._binding(binding_id)
        account_id = binding["account_id"]
        row = self._row(account_id)
        self._writer(account_id)
        self._reject_s03_lease(account_id, owner)
        # Replays do not create risk, but are still controller operations.
        # Validate the ownership generation and exact token types before
        # returning any prior receipt (bool is not an integer CAS token).
        if (
            type(expected_epoch) is not int
            or type(expected_sequence) is not int
            or type(fence) is not int
            or expected_epoch < 0
            or expected_sequence < 0
            or row["controller_fence"] != fence
        ):
            raise AstarterConflict("ASTARTER_RISK_EPOCH_CONFLICT")
        request_hash = digest(
            dict(
                binding_id=binding_id,
                opportunity=asdict(opportunity),
                policy_sha256=binding["policy_sha256"],
                admission_id=admission_id,
            )
        )
        prior = self._c.execute(
            "SELECT * FROM astarter_intents WHERE account_id=? AND opportunity_key=?",
            (account_id, opportunity.key),
        ).fetchone()
        if prior is not None:
            if prior["request_sha256"] != request_hash:
                raise AstarterConflict("ASTARTER_OPPORTUNITY_CONFLICT")
        self._admission.check(
            self.controller_identity, binding, policy, admission_id,
            now_ms=self._admission_now(),
        )
        if prior is not None:
            return Reservation(**_decode(prior["receipt_bytes"]))
        if (
            row["risk_epoch"] != expected_epoch
            or row["last_sequence"] != expected_sequence
        ):
            raise AstarterConflict("ASTARTER_RISK_EPOCH_CONFLICT")
        if (
            self._c.execute(
                "SELECT 1 FROM s03_runs WHERE account_id=? AND status='ACTIVE'", (account_id,)
            ).fetchone()
            is not None
        ):
            prior_intents = self._c.execute(
                "SELECT * FROM astarter_intents WHERE account_id=?", (account_id,)
            ).fetchall()
            if any(
                i["state"] not in {"CLOSED", "NO_FILL"}
                or any(
                    amount(i[key]) != 0 for key in ("pending_risk", "cash_hold", "inventory_risk")
                )
                or any(
                    o.native_state not in TERMINAL and o.dispatch_state != "CANCELED_LOCAL"
                    for o in self.orders(str(i["intent_id"]))
                )
                for i in prior_intents
            ):
                raise AstarterBlocked("ASTARTER_S03_PRIOR_INTENT_UNRESOLVED")
        if self._locks(row):
            raise AstarterBlocked("ASTARTER_ACCOUNT_HALTED")
        snap = self._latest(row, policy.snapshot_ttl_ns)
        if not snap.cash_reconciled:
            raise AstarterBlocked("ASTARTER_NATIVE_RECONCILIATION_REQUIRED")
        validate_opportunity(opportunity, now_ns=snap.now_ns, policy=policy)
        if amount(snap.ask) <= amount(policy.stop):
            raise AstarterBlocked("ASTARTER_STOP_ALREADY_IN_MARKET")
        view = self._view(account_id)
        gross = amount(snap.quote_total) + amount(snap.base_total) * amount(snap.bid)
        equity = gross - amount(row["locked_reserve"])
        if equity <= 0:
            raise AstarterBlocked("ASTARTER_NONPOSITIVE_TRADABLE_EQUITY")
        staged = risk.staged_risk(
            "USDT",
            text(equity),
            "0.0025",
            "0.0025",
            "0.0025",
            policy.account_multiplier,
            policy.stage,
        )
        requested = min(amount(opportunity.requested_risk), amount(staged.risk_quote))
        open_costs = self._open_cost_debit(account_id)
        budget_rows = tuple(
            risk.BudgetLimit(
                v["scope"],
                v["cap"],
                text(amount(v["booked_debit"]) + open_costs),
                view.inventory_risk,
                view.pending_risk,
            )
            for v in self._c.execute(
                "SELECT * FROM astarter_limits WHERE account_id=? ORDER BY scope", (account_id,)
            )
        )
        available = risk.remaining_budget("USDT", text(requested), budget_rows)
        cash = max(
            F(0),
            amount(snap.quote_total) - amount(view.cash_hold) - amount(row["locked_reserve"]),
        )
        sized = risk.size_spot(
            policy.profile(),
            risk.SizingLimits(
                risk.Pair("BTC", "USDT"),
                available.candidate_risk,
                policy.nominal_cap,
                text(cash),
                policy.step,
                "5",
            ),
        )
        if sized.costs is None:
            raise AstarterBlocked("ASTARTER_NO_FEASIBLE_ORDER")
        intent = str(uuid4())
        native_id = (
            "AST-" + sha256((account_id + opportunity.key).encode()).hexdigest()[:22] + "-E"
        )
        result = Reservation(
            intent,
            account_id,
            native_id,
            sized.costs.quantity,
            sized.costs.reserve,
            available.candidate_risk,
            sized.costs.stress_loss,
            policy.cap,
            policy.stop,
            row["risk_epoch"] + 1,
            opportunity.expires_at_ns,
        )
        self._c.execute(
            (
                "INSERT INTO astarter_intents(intent_id,account_id,binding_id,"
                "opportunity_key,request_sha256,receipt_bytes,entry_order_id,state,"
                "pending_risk,cash_hold) VALUES(?,?,?,?,?,?,?,'RESERVED',?,?)"
            ),
            (
                intent,
                account_id,
                binding_id,
                opportunity.key,
                request_hash,
                encode(asdict(result)),
                native_id,
                result.risk_reserved,
                result.cash_hold,
            ),
        )
        self._c.execute(
            (
                "INSERT INTO astarter_orders(order_id,account_id,intent_id,role,quantity) "
                "VALUES(?,?,?,'ENTRY',?)"
            ),
            (native_id, account_id, intent, result.quantity),
        )
        self._admission.link(intent, binding, admission_id)
        self._audit(account_id, "RISK_RESERVED", asdict(result))
        self._bump(account_id)
        return result

    def _refresh_s03_action_locked(
        self,
        account_id: str,
        owner: object | None,
        source: NativeFactsSource | None,
    ) -> None:
        self._reject_s03_lease(account_id, owner)
        run = self._c.execute(
            "SELECT venue_session FROM s03_runs WHERE account_id=? AND status='ACTIVE'",
            (account_id,),
        ).fetchone()
        if run is None:
            return
        if type(source) is not NativeFactsSource:
            raise AstarterBlocked("ASTARTER_S03_SOURCE_REQUIRED")
        snap = source.capture()
        source.verify(snap)
        if snap.account_id != account_id or snap.venue_session != run[0]:
            raise AstarterBlocked("ASTARTER_S03_SOURCE_REQUIRED")
        self._observe_locked(snap)

    def _claim_order_locked(
        self, order_id: str, *, fence: int, owner: object | None = None
    ) -> OrderCommand | None:
        order = self._c.execute(
            "SELECT * FROM astarter_orders WHERE order_id=?", (order_id,)
        ).fetchone()
        if order is None:
            raise AstarterBlocked("ASTARTER_ORDER_NOT_FOUND")
        account = self._row(order["account_id"])
        self._reject_s03_lease(str(account["account_id"]), owner)
        if type(fence) is not int or fence != account["controller_fence"]:
            raise AstarterConflict("ASTARTER_CONTROLLER_FENCED")
        if order["dispatch_state"] != "PENDING":
            return None
        intent = self._c.execute(
            "SELECT * FROM astarter_intents WHERE intent_id=?", (order["intent_id"],)
        ).fetchone()
        receipt = Reservation(**_decode(intent["receipt_bytes"]))
        if order["role"] == "ENTRY":
            binding, policy = self._binding(intent["binding_id"])
            self._admission.check(
                self.controller_identity, binding, policy,
                self._admission.intent_admission(intent["intent_id"]),
                now_ms=self._admission_now(),
            )
            if self._locks(account) or intent["state"] != "RESERVED":
                raise AstarterBlocked("ASTARTER_ACCOUNT_HALTED")
            current = self._latest(account, policy.snapshot_ttl_ns)
            action_ns = self._action_time_ns(str(account["account_id"]), current.now_ns)
            if owner is not None:
                from stark_trading_os.control.s03_bridge import S03BridgeControl

                S03BridgeControl(self._store, control=self)._validate_entry_claim_locked(
                    cast(S03Owner, owner), order_id, action_ns
                )
                if not amount(receipt.cap) >= amount(current.ask) > amount(receipt.stop):
                    raise AstarterBlocked("ASTARTER_S03_ENTRY_PRICE_CHANGED")
            if action_ns >= receipt.expires_at_ns:
                self._c.execute(
                    ("UPDATE astarter_orders SET dispatch_state='CANCELED_LOCAL' WHERE order_id=?"),
                    (order_id,),
                )
                self._c.execute(
                    (
                        "UPDATE astarter_intents SET state='NO_FILL',pending_risk='0',"
                        "cash_hold='0' WHERE intent_id=?"
                    ),
                    (order["intent_id"],),
                )
                self._audit(
                    order["account_id"], "OPPORTUNITY_EXPIRED_UNSENT", dict(order_id=order_id)
                )
                self._bump(order["account_id"])
                return None
            self._c.execute(
                "UPDATE astarter_intents SET state='DISPATCHING' WHERE intent_id=?",
                (order["intent_id"],),
            )
        else:
            if order["role"] == "EXIT":
                self._reject_s03_lease(str(account["account_id"]))
            _, policy = self._binding(intent["binding_id"], require_active=False)
            current = self._latest(account, policy.snapshot_ttl_ns)
            action_ns = self._action_time_ns(str(account["account_id"]), current.now_ns)
            if not current.cash_reconciled or self._locks(account) & {
                "RECONCILE_REQUIRED",
                "NATIVE_INTEGRITY",
            }:
                raise AstarterBlocked("ASTARTER_NATIVE_RECONCILIATION_REQUIRED")
            q = amount(order["quantity"])
            inventory = self._inventory(order["intent_id"])
            competitors = self.orders(order["intent_id"])
            competing = sum(
                (
                    amount(o.quantity)
                    - sum(
                        (amount(f.quantity) for f in current.fills if f.order_id == o.order_id),
                        F(0),
                    )
                    for o in competitors
                    if o.order_id != order_id
                    and o.role in {"STOP", "EXIT"}
                    and o.native_state not in TERMINAL
                    and o.dispatch_state != "CANCELED_LOCAL"
                ),
                F(0),
            )
            if (
                intent["state"] in {"CLOSED", "NO_FILL"}
                or q <= 0
                or q + competing > inventory
                or amount(current.base_free) < q
                or amount(current.position_quantity) < q
            ):
                raise AstarterBlocked("ASTARTER_REDUCTION_COVERAGE_REQUIRED")
            if order["role"] == "EXIT" and (
                intent["state"] != "CLOSING"
                or any(
                    o.order_id != order_id
                    and o.native_state not in TERMINAL
                    and o.dispatch_state != "CANCELED_LOCAL"
                    for o in competitors
                )
            ):
                raise AstarterBlocked("ASTARTER_EXIT_RECONCILIATION_REQUIRED")
            residual = self._is_s03_residual(order)
            if order["role"] == "STOP" and (
                (
                    not residual
                    and intent["state"] == "CLOSING"
                    and any(o.role == "ENTRY" and o.native_state in TERMINAL for o in competitors)
                )
                or action_ns > order["deadline_ns"]
                or (not residual and "PROTECTION_FAILED" in self._locks(account))
                or amount(current.bid) <= amount(order["trigger_price"])
            ):
                raise AstarterBlocked("ASTARTER_PROTECTION_PLAN_NO_LONGER_VALID")
        self._c.execute(
            "UPDATE astarter_orders SET dispatch_state='DISPATCHING' WHERE order_id=?",
            (order_id,),
        )
        self._audit(
            order["account_id"],
            "NATIVE_DISPATCH_CLAIMED",
            dict(
                order_id=order_id,
                role=order["role"],
                fence=fence,
                started_at_ns=action_ns,
                deadline_ns=action_ns + 1_000_000_000,
                operation="SUBMIT",
            ),
        )
        self._bump(order["account_id"])
        price = receipt.cap if order["role"] == "ENTRY" else order["trigger_price"]
        return OrderCommand(order_id, order["intent_id"], order["role"], order["quantity"], price)

    def stored_snapshot(self, account_id: str) -> NativeSnapshot | None:
        row = self._row(account_id)
        raw = row["last_snapshot"]
        if raw is None or sha256(raw).hexdigest() != row["last_snapshot_sha256"]:
            return None
        return _snapshot(raw)

    def _accepted_protection(self, intent_id: str, snap: NativeSnapshot) -> F:
        receipt = Reservation(**_decode(self._intent(intent_id)["receipt_bytes"]))
        native = {o.order_id: o for o in snap.orders}
        covered = F(0)
        for order in self.orders(intent_id):
            fact = native.get(order.order_id)
            if (
                order.role == "STOP"
                and not order.cancel_requested
                and order.dispatch_state == "OBSERVED"
                and fact is not None
                and fact.side == "SELL"
                and fact.order_type == "STOP_MARKET"
                and fact.state in {"ACCEPTED", "PARTIALLY_FILLED"}
                and fact.trigger_price == receipt.stop
                and amount(fact.quantity) == amount(order.quantity)
                and fact.accepted_at_ns is not None
                and order.deadline_ns is not None
                and fact.accepted_at_ns <= order.deadline_ns
            ):
                covered += amount(fact.quantity) - amount(fact.filled)
        return covered

    def _uncovered_fill_time(self, intent_id: str, covered: F) -> int | None:
        fills = sorted(self._intent_fills(intent_id), key=lambda v: (v.time_ns, v.trade_id))
        skipped = covered + sum((amount(v.quantity) for v in fills if v.side == "SELL"), F(0))
        for fill in fills:
            if fill.side != "BUY":
                continue
            qty = amount(fill.quantity)
            if skipped >= qty:
                skipped -= qty
            else:
                return fill.time_ns
        return None

    def _s03_command_timeouts(self, account_id: str, now_ns: int) -> bool:
        # Claim and cancel start times live in the existing append-only audit.
        snap = self.stored_snapshot(account_id)
        native = {} if snap is None else {o.order_id: o for o in snap.orders}
        unknown = False
        repaired: set[str] = set()
        for row in self._c.execute(
            "SELECT fact_bytes,fact_sha256 FROM astarter_audit WHERE account_id=? AND "
            "kind='S03_COMMAND_RECONCILED'",
            (account_id,),
        ):
            if sha256(row[0]).hexdigest() != row[1]:
                raise AstarterIntegrityError("ASTARTER_AUDIT_CORRUPT")
            repaired.add(_decode(row[0])["claim_sha256"])
        for row in self._c.execute(
            "SELECT fact_bytes,fact_sha256 FROM astarter_audit WHERE account_id=? "
            "AND kind IN ('NATIVE_DISPATCH_CLAIMED','NATIVE_CANCEL_INTENT')",
            (account_id,),
        ):
            if sha256(row[0]).hexdigest() != row[1]:
                raise AstarterIntegrityError("ASTARTER_AUDIT_CORRUPT")
            event = _decode(row[0])
            if row[1] in repaired:
                continue
            deadline = event.get("deadline_ns")
            if deadline is None:
                unknown = True
                continue
            if now_ns <= deadline:
                continue
            order = native.get(event["order_id"])
            terminal = (
                order is not None
                and order.state in TERMINAL
                and order.state_time_ns is not None
                and order.state_time_ns <= deadline
            )
            if event.get("operation") == "CANCEL":
                resolved = terminal
            else:
                resolved = terminal or (
                    order is not None
                    and order.accepted_at_ns is not None
                    and order.accepted_at_ns <= deadline
                )
            unknown |= not resolved
        if unknown:
            self._set_locks(account_id, self._locks(self._row(account_id)) | {"RECONCILE_REQUIRED"})
        return unknown

    def _is_s03_residual(self, order: sqlite3.Row) -> bool:
        row = self._c.execute(
            "SELECT l.residual_used,l.reasons FROM s03_lifecycle l JOIN s03_runs r "
            "ON r.run_id=l.run_id JOIN s03_signals s ON s.run_id=r.run_id "
            "WHERE r.account_id=? AND s.intent_id=? AND r.status='ACTIVE'",
            (order["account_id"], order["intent_id"]),
        ).fetchone()
        return (
            row is not None
            and bool(row[0])
            and f"RESIDUAL_ORDER:{order['order_id']}" in _decode(row[1])
        )

    def _s03_exit_target(self, intent_id: str) -> bool | None:
        intent = self._intent(intent_id)
        run = self._c.execute(
            "SELECT run_id FROM s03_runs WHERE account_id=? AND status='ACTIVE'",
            (intent["account_id"],),
        ).fetchone()
        if run is None:
            return None
        from stark_trading_os.control.s03_bridge import S03BridgeControl

        life = S03BridgeControl(self._store, control=self)._life(str(run[0]))
        if life.active_intent_id != intent_id:
            raise AstarterBlocked("ASTARTER_S03_INACTIVE_INTENT")
        return life.exit_target is not None

    def _request_exit_locked(self, intent_id: str, owner: object | None) -> None:
        intent = self._intent(intent_id)
        self._reject_s03_lease(str(intent["account_id"]), owner)
        if self._s03_exit_target(intent_id) is False:
            raise AstarterBlocked("ASTARTER_S03_EXIT_TARGET_REQUIRED")
        if intent["state"] in {"CLOSING", "CLOSED", "NO_FILL"}:
            return
        self._binding(intent["binding_id"], require_active=False)
        self._c.execute(
            "UPDATE astarter_intents SET state='CLOSING' WHERE intent_id=?", (intent_id,)
        )
        self._audit(intent["account_id"], "EXIT_TARGET_ZERO", dict(intent_id=intent_id))
        self._bump(intent["account_id"])

    def _prepare_exit_locked(
        self,
        intent_id: str,
        owner: object | None,
        *,
        allow_same_snapshot: bool = False,
    ) -> OrderCommand | None:
        intent = self._intent(intent_id)
        self._reject_s03_lease(str(intent["account_id"]), owner)
        if intent["state"] != "CLOSING":
            return None
        _, policy = self._binding(intent["binding_id"], require_active=False)
        row = self._row(intent["account_id"])
        snap = self._latest(row, policy.snapshot_ttl_ns)
        if self._locks(row) & {"RECONCILE_REQUIRED", "NATIVE_INTEGRITY"}:
            return None
        orders = self.orders(intent_id)
        pending = [o for o in orders if o.role == "EXIT" and o.dispatch_state == "PENDING"]
        if any(
            o.native_state not in TERMINAL
            and o.dispatch_state != "CANCELED_LOCAL"
            and o not in pending
            for o in orders
        ):
            return None
        q = self._inventory(intent_id)
        if (
            not snap.cash_reconciled
            or q <= 0
            or amount(snap.base_free) < q
            or amount(snap.position_quantity) < q
        ):
            return None
        if pending:
            if len(pending) != 1 or amount(pending[0].quantity) != q:
                raise AstarterIntegrityError("ASTARTER_PENDING_EXIT_COVERAGE_CONFLICT")
            return OrderCommand(pending[0].order_id, intent_id, "EXIT", text(q), None)
        if not allow_same_snapshot and snap.now_ns <= intent["last_exit_attempt_ns"]:
            return None
        receipt = Reservation(**_decode(intent["receipt_bytes"]))
        ordinal = 1 + sum(o.role == "EXIT" for o in orders)
        key = receipt.entry_order_id[:-1] + ("X" if ordinal == 1 else f"X{ordinal}")
        self._c.execute(
            (
                "INSERT INTO astarter_orders(order_id,account_id,intent_id,role,quantity) "
                "VALUES(?,?,?,'EXIT',?)"
            ),
            (key, intent["account_id"], intent_id, text(q)),
        )
        self._c.execute(
            "UPDATE astarter_intents SET last_exit_attempt_ns=? WHERE intent_id=?",
            (snap.now_ns, intent_id),
        )
        self._audit(intent["account_id"], "EXIT_INTENT", dict(order_id=key, quantity=text(q)))
        self._bump(intent["account_id"])
        return OrderCommand(key, intent_id, "EXIT", text(q), None)

    def _reject_s03_entry(self, account_id: str) -> None:
        self._writer(account_id)
        self._reject_s03_lease(account_id)
        head = self._admission.head(self.controller_identity)
        if head["authority_id"] == S03_FINITE_AUTHORITY:
            raise AstarterBlocked("ASTARTER_S03_BRIDGE_REQUIRED")
