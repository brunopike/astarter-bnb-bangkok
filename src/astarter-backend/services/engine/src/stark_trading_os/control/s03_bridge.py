"""S03 lease on the existing Control database. No second cash ledger."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, replace
from fractions import Fraction as F
from secrets import token_hex
from typing import Any
from uuid import uuid4

from stark_trading_os.control.astarter.service import AstarterControl
from stark_trading_os.control.database import _immediate_transaction
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import (
    AstarterIntegrityError,
    NativeSnapshot,
    Opportunity,
    Reservation,
    SimulationPolicy,
    amount,
    digest,
    encode,
    policy_bytes,
    text,
)
from stark_trading_os.domain.s03_bridge import (
    S03_FINITE_AUTHORITY,
    S03BridgePlan,
    S03BridgeRejected,
    S03DataManifest,
    S03Life,
    S03Owner,
    S03RawNews,
    S03RunState,
    advance_s03_time,
    apply_s03_exit_fact,
    claim_s03_exit,
    claim_s03_residual,
    local_simulation_case,
    lock_s03_reason,
    note_s03_timer,
    release_s03_reason,
    s03_bound_source_event_time,
    s03_entry_locked,
    s03_manifest_sha256,
    s03_match_observation,
    s03_quote_clock,
    s03_trade_terms,
    step_s03_life,
    validate_s03_plan,
    validate_s03_signal,
)
from stark_trading_os.domain.s03_signal import S03MarketSignal
from stark_trading_os.runner.astarter_facts import NativeFactsSource
from stark_trading_os.runner.s03_bridge_source import (
    S03InputEvent,
    S03QuoteBody,
    _off_grid,
    s03_event_key,
)
from stark_trading_os.runner.s03_indicators import S03SignalObservation


class S03BridgeControl:
    """One controller. Reading state never refreshes its owner credential."""

    def __init__(self, store: ControlStore, *, control: AstarterControl) -> None:
        if type(store) is not ControlStore:
            raise TypeError("S03 requires the existing exact ControlStore")
        self._store = store
        self._c = store._connection
        if type(control) is not AstarterControl or control._store is not store:
            raise TypeError("S03 requires the same controlled Astarter instance")
        self._astarter = control
        context = control._admission.required(control.controller_identity)
        if context.purpose != "LEGACY_FINITE" or context.authority_id != S03_FINITE_AUTHORITY:
            raise S03BridgeRejected("S03_FINITE_AUTHORITY_REQUIRED")

    def activate(
        self,
        source: NativeFactsSource,
        plan: S03BridgePlan,
        manifest: S03DataManifest,
    ) -> S03Owner:
        plan = S03BridgePlan.model_validate(plan)
        manifest = S03DataManifest.model_validate(manifest)
        validate_s03_plan(plan, manifest, local_simulation_case())
        if plan.review.reactivation_binding is not None:
            raise S03BridgeRejected("S03_REACTIVATION_ONLY")
        if type(source) is not NativeFactsSource:
            raise S03BridgeRejected("S03_NATIVE_SOURCE_INVALID")
        self._astarter._access.check_source(source.account_id, source.venue_session)
        snap = source.capture()
        source.verify(snap)
        s03_bound_source_event_time(snap)
        if snap.base_total != "0" or snap.orders or snap.fills or not snap.cash_reconciled:
            raise S03BridgeRejected("S03_ACCOUNT_NOT_FLAT")
        self._astarter.activate(source, SimulationPolicy(), component_id=plan.parameters_sha256)
        token = token_hex(32)
        owner_id = _sha(f"{manifest_digest(manifest)}:{snap.venue_session}:owner")
        run_id = _sha(f"{manifest_digest(manifest)}:{snap.venue_session}:run")
        with _immediate_transaction(self._c):
            self._astarter._writer(snap.account_id)
            self._scope(snap.account_id, snap.venue_session)
            source.verify(snap)
            busy = self._c.execute(
                "SELECT intent_id FROM astarter_intents WHERE account_id=? AND state NOT IN "
                "('CLOSED','NO_FILL')",
                (snap.account_id,),
            ).fetchone()
            if busy is not None:
                raise S03BridgeRejected("S03_ACCOUNT_BUSY")
            existing = self._c.execute(
                "SELECT status FROM s03_runs WHERE account_id=?",
                (snap.account_id,),
            ).fetchone()
            if existing is not None and existing["status"] == "ACTIVE":
                raise S03BridgeRejected("S03_ACCOUNT_LEASED")
            self._c.execute(
                "INSERT INTO s03_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    run_id,
                    snap.account_id,
                    snap.venue_session,
                    plan.group_id,
                    plan.parameters_sha256,
                    manifest_digest(manifest),
                    owner_id,
                    1,
                    1,
                    _sha(token),
                    "ACTIVE",
                    plan.starts_at_ns,
                    plan.expires_at_ns,
                    None,
                    None,
                    encode(["ACTIVE"]),
                    0,
                ),
            )
            self._c.execute(
                "INSERT INTO s03_lifecycle(run_id,reasons) VALUES(?,?)",
                (run_id, encode([])),
            )
            self._c.execute(
                "INSERT INTO s03_plan_manifest VALUES(?,?,?)",
                (
                    run_id,
                    json.dumps(plan.model_dump(mode="json"), sort_keys=True),
                    json.dumps(manifest.model_dump(mode="json"), sort_keys=True),
                ),
            )
            self._audit(run_id, "S03_ACTIVATED", {"owner_id": owner_id, "fence": 1})
        return S03Owner(
            owner_id=owner_id,
            run_id=run_id,
            venue_session=snap.venue_session,
            fence=1,
            credential=token,
        )

    def state(self, run_id: str) -> S03RunState:
        return self._state(self._run(run_id))

    def takeover(self, source: NativeFactsSource, run_id: str) -> S03Owner:
        if type(source) is not NativeFactsSource:
            raise S03BridgeRejected("S03_NATIVE_SOURCE_INVALID")
        source.bound_instrument()
        token = token_hex(32)
        with _immediate_transaction(self._c):
            row = self._run(run_id)
            self._astarter._writer(str(row["account_id"]))
            if (row["venue_session"] != source.venue_session
                    or row["account_id"] != source.account_id or row["status"] != "ACTIVE"):
                raise S03BridgeRejected("S03_TAKEOVER_SESSION_MISMATCH")
            fence = int(row["fence"]) + 1
            epoch = int(row["owner_epoch"]) + 1
            owner_id = _sha(f"{run_id}:{epoch}")
            self._c.execute(
                "UPDATE s03_runs SET owner_id=?, owner_epoch=?, fence=?, credential_sha256=? "
                "WHERE run_id=?",
                (owner_id, epoch, fence, _sha(token), run_id),
            )
            self._audit(run_id, "S03_TAKEOVER", {"fence": fence, "owner_id": owner_id})
            fresh = self._run(run_id)
        return S03Owner(
            owner_id=str(fresh["owner_id"]),
            run_id=run_id,
            venue_session=str(fresh["venue_session"]),
            fence=int(fresh["fence"]),
            credential=token,
        )

    def ingest(
        self, owner: S03Owner, source: NativeFactsSource, event: S03InputEvent
    ) -> S03RunState:
        event = S03InputEvent.model_validate(event)
        try:
            with _immediate_transaction(self._c):
                self._auth(owner)
                snap = self._snap(source)
                if not self._ingest_locked(owner.run_id, snap, event):
                    return self._state(self._run(owner.run_id))
                self._astarter._observe_locked(snap)
                self._after_ingest(owner.run_id)
                return self._state(self._run(owner.run_id))
        except S03BridgeRejected as error:
            self._record_source_failure(owner, error.code)
            raise

    def _ingest_locked(self, run_id: str, snap: NativeSnapshot, event: S03InputEvent) -> bool:
        run = self._run(run_id)
        if snap.account_id != run["account_id"] or snap.venue_session != run["venue_session"]:
            raise S03BridgeRejected("S03_SOURCE_SESSION_MISMATCH")
        if event.event_key != s03_event_key(event):
            raise S03BridgeRejected("S03_EVENT_KEY_INVALID")
        content = digest(event.model_dump(mode="json"))
        prior = self._c.execute(
            "SELECT content_sha256 FROM s03_events WHERE run_id=? AND event_key=?",
            (run_id, event.event_key),
        ).fetchone()
        if prior is not None:
            if prior["content_sha256"] != content:
                raise S03BridgeRejected("S03_EVENT_CONFLICT")
            return False
        _, manifest = self._load(run_id)
        if event.kind == "QUOTE" and event.quote is not None:
            q = event.quote
            identity = (
                q.source_sequence,
                event.source_event_time_ns,
                event.received_time_ns,
                q.bid,
                q.ask,
                q.bid_size,
                q.ask_size,
                q.instrument_id,
            )
            approved = [
                (
                    x.source_sequence,
                    x.source_event_time_ns,
                    x.received_time_ns,
                    x.bid,
                    x.ask,
                    x.bid_size,
                    x.ask_size,
                    x.instrument_id,
                )
                for x in manifest.quotes
            ]
            if identity not in approved or event.available_at_ns != event.received_time_ns:
                raise S03BridgeRejected("S03_QUOTE_NOT_IN_MANIFEST")
            if (
                q.bid,
                q.ask,
                q.bid_size,
                q.ask_size,
                event.source_event_time_ns,
                event.received_time_ns,
            ) != (
                snap.bid,
                snap.ask,
                snap.bid_size,
                snap.ask_size,
                snap.source_event_time_ns,
                snap.quote_time_ns,
            ):
                raise S03BridgeRejected("S03_QUOTE_NATIVE_MISMATCH")
            if (
                any(_off_grid(x, "0.01") for x in (q.bid, q.ask))
                or amount(q.ask) < amount(q.bid)
                or any(_off_grid(x, "0.00001") for x in (q.bid_size, q.ask_size))
            ):
                raise S03BridgeRejected("S03_QUOTE_INVALID")
            if not s03_quote_clock(snap, snap.now_ns) or event.available_at_ns > snap.now_ns:
                raise S03BridgeRejected("S03_QUOTE_CLOCK")
            if (
                run["quote_watermark"] is not None and q.source_sequence <= run["quote_watermark"]
            ) or (
                run["quote_event_ns"] is not None
                and event.source_event_time_ns <= run["quote_event_ns"]
            ):
                raise S03BridgeRejected("S03_QUOTE_WATERMARK")
            if (
                run["quote_event_ns"] is not None
                and snap.now_ns - run["quote_event_ns"] > 2_000_000_000
            ):
                self._mark_health_fault(run_id, "QUOTE_UNHEALTHY", snap.now_ns)
            self._c.execute(
                "UPDATE s03_runs SET quote_watermark=?,quote_event_ns=? WHERE run_id=?",
                (q.source_sequence, event.source_event_time_ns, run_id),
            )
        elif event.kind == "NEWS" and event.news is not None:
            news = event.news
            if news not in manifest.news or not self._news_clock(news, snap.now_ns):
                raise S03BridgeRejected("S03_NEWS_UNTRUSTED")
            history = self._news_history(run_id)
            last = history[-1] if history else None
            if news.previous_sequence != (last.source_sequence if last else 0) or (
                last is not None
                and (
                    news.source_event_time_ns <= last.source_event_time_ns
                    or news.received_time_ns <= last.received_time_ns
                )
            ):
                raise S03BridgeRejected("S03_NEWS_CONTINUITY")
            if last is not None and not self._news_clock(last, snap.now_ns):
                self._mark_health_fault(run_id, "NEWS_UNHEALTHY", snap.now_ns)
            if news.status == "SEVERE":
                life = self._life(run_id)
                reasons = _with_reason(
                    _with_reason(life.reasons, "NEWS_LOCK"), f"NEWS_INCIDENT:{news.incident_id}"
                )
                self._save_life(run_id, replace(life, reasons=reasons))
        else:
            raise S03BridgeRejected("S03_EVENT_UNTRUSTED")
        self._c.execute(
            "INSERT INTO s03_events VALUES(?,?,?,?,?,?)",
            (
                run_id,
                event.event_key,
                event.kind,
                content,
                event.source_event_time_ns,
                event.received_time_ns,
            ),
        )
        self._audit(run_id, "S03_INGEST", {"event_key": event.event_key, "kind": event.kind})
        self._recover_health_locked(run_id, snap)
        return True

    @staticmethod
    def _news_clock(news: S03RawNews, now_ns: int) -> bool:
        return (
            0
            <= news.source_event_time_ns
            <= news.received_time_ns
            <= news.available_at_ns
            <= now_ns
        ) and all(
            0 <= stamp <= now_ns and now_ns - stamp <= 120_000_000_000
            for stamp in (news.source_event_time_ns, news.received_time_ns)
        )

    def _news_history(self, run_id: str) -> list[S03RawNews]:
        _, manifest = self._load(run_id)
        keys = {
            row[0]
            for row in self._c.execute(
                "SELECT event_key FROM s03_events WHERE run_id=? AND kind='NEWS'", (run_id,)
            )
        }
        result = []
        for news in manifest.news:
            event = S03InputEvent(
                kind="NEWS",
                event_key="0" * 64,
                source_event_time_ns=news.source_event_time_ns,
                received_time_ns=news.received_time_ns,
                available_at_ns=news.available_at_ns,
                news=news,
            )
            if s03_event_key(event) in keys:
                result.append(news)
        return sorted(result, key=lambda item: item.source_sequence)

    def _qualify_quote_locked(self, run_id: str, snap: NativeSnapshot) -> None:
        if not s03_quote_clock(snap, snap.now_ns):
            raise S03BridgeRejected("S03_QUOTE_CLOCK")
        _, manifest = self._load(run_id)
        matches = [
            q
            for q in manifest.quotes
            if (q.source_event_time_ns, q.received_time_ns, q.bid, q.ask, q.bid_size, q.ask_size)
            == (
                snap.source_event_time_ns,
                snap.quote_time_ns,
                snap.bid,
                snap.ask,
                snap.bid_size,
                snap.ask_size,
            )
        ]
        if len(matches) != 1:
            raise S03BridgeRejected("S03_QUOTE_NOT_IN_MANIFEST")
        q = matches[0]
        event = S03InputEvent(
            kind="QUOTE",
            event_key="0" * 64,
            source_event_time_ns=q.source_event_time_ns,
            received_time_ns=q.received_time_ns,
            available_at_ns=q.received_time_ns,
            quote=S03QuoteBody(
                source_sequence=q.source_sequence,
                bid=q.bid,
                ask=q.ask,
                bid_size=q.bid_size,
                ask_size=q.ask_size,
                instrument_id=q.instrument_id,
            ),
        )
        self._ingest_locked(
            run_id, snap, event.model_copy(update={"event_key": s03_event_key(event)})
        )

    def _require_new_risk_inputs(self, run_id: str, snap: NativeSnapshot) -> None:
        self._qualify_quote_locked(run_id, snap)
        history = self._news_history(run_id)
        if not history or not self._news_clock(history[-1], snap.now_ns):
            raise S03BridgeRejected("S03_NEWS_UNHEALTHY")
        if s03_entry_locked(self._life(run_id)):
            raise S03BridgeRejected("S03_NEW_RISK_LOCKED")

    def _record_source_failure(self, owner: S03Owner, code: str) -> None:
        if not code.startswith(("S03_QUOTE_", "S03_NEWS_", "S03_EVENT_", "S03_SOURCE_")):
            return
        with _immediate_transaction(self._c):
            self._auth(owner)
            self._remember_reason(owner.run_id, code)

    def _mark_health_fault(self, run_id: str, code: str, now_ns: int) -> None:
        life = self._life(run_id)
        if code not in life.reasons:
            self._save_life(run_id, replace(life, reasons=_with_reason(life.reasons, code)))
            self._audit(run_id, f"S03_HEALTH_FAULT:{code}", {"at_ns": now_ns})

    def _recover_health_locked(self, run_id: str, snap: NativeSnapshot) -> None:
        life = self._life(run_id)
        reasons = life.reasons
        for code, kind, gap in (
            ("QUOTE_UNHEALTHY", "QUOTE", 0),
            ("SOURCE_UNTRUSTED", "QUOTE", 0),
            ("NEWS_UNHEALTHY", "NEWS", 5_000_000_000),
        ):
            if code not in reasons:
                continue
            row = self._c.execute(
                "SELECT seq,fact_bytes,fact_sha256 FROM s03_audit WHERE run_id=? AND kind=? "
                "ORDER BY seq DESC LIMIT 1",
                (run_id, f"S03_HEALTH_FAULT:{code}"),
            ).fetchone()
            if row is None:
                continue
            if hashlib.sha256(bytes(row["fact_bytes"])).hexdigest() != row["fact_sha256"]:
                raise S03BridgeRejected("S03_AUDIT_INVALID")
            accepted = []
            for audit in self._c.execute(
                "SELECT fact_bytes,fact_sha256 FROM s03_audit WHERE run_id=? AND "
                "kind='S03_INGEST' AND seq>? ORDER BY seq",
                (run_id, row["seq"]),
            ):
                if hashlib.sha256(bytes(audit[0])).hexdigest() != audit[1]:
                    raise S03BridgeRejected("S03_AUDIT_INVALID")
                fact = json.loads(bytes(audit[0]))
                if fact.get("kind") == kind:
                    accepted.append(fact["event_key"])
            stamps = [
                r
                for r in self._c.execute(
                    "SELECT event_key,source_event_time_ns,received_time_ns FROM s03_events "
                    "WHERE run_id=? AND kind=? ORDER BY source_event_time_ns",
                    (run_id, kind),
                )
                if r[0] in accepted
            ]
            if kind == "NEWS":
                healthy_times = {
                    n.source_event_time_ns
                    for n in self._news_history(run_id)
                    if n.status in {"HEALTHY", "CLEARED"}
                }
                stamps = [r for r in stamps if r[1] in healthy_times]
            if len(stamps) < 2 or int(stamps[-1][1]) - int(stamps[-2][1]) < gap:
                continue
            if not snap.cash_reconciled or snap.position_quantity != snap.base_total:
                continue
            if amount(snap.position_quantity) > 0:
                covered = sum(
                    (
                        self._astarter._accepted_protection(str(r[0]), snap)
                        for r in self._c.execute(
                            "SELECT intent_id FROM s03_signals WHERE run_id=?", (run_id,)
                        )
                    ),
                    F(0),
                )
                if covered < amount(snap.position_quantity):
                    continue
            if kind == "NEWS" and not self._news_clock(self._news_history(run_id)[-1], snap.now_ns):
                continue
            reasons = tuple(r for r in reasons if r != code)
            self._audit(run_id, "S03_HEALTH_RESTORED", {"code": code})
        self._save_life(run_id, replace(life, reasons=reasons))

    def _after_ingest(self, run_id: str) -> None:
        return None

    def note_recovery(self, owner: S03Owner) -> S03RunState:
        with _immediate_transaction(self._c):
            self._auth(owner)
            self._note_recovery_locked(owner)
            return self._state(self._run(owner.run_id))

    def _note_recovery_locked(self, owner: S03Owner) -> None:
        self._auth(owner)
        row = self._run(owner.run_id)
        reasons = _with_reason(
            tuple(json.loads(bytes(row["reasons"]))), "RECOVERY_REACTIVATION_REQUIRED"
        )
        self._c.execute(
            "UPDATE s03_runs SET reasons=?, recovery_reactivation=1 WHERE run_id=?",
            (encode(list(reasons)), owner.run_id),
        )
        self._audit(owner.run_id, "S03_RECOVERY_REQUIRED", {"fence": owner.fence})

    def reserve_signal(
        self,
        owner: S03Owner,
        source: NativeFactsSource,
        signal: S03MarketSignal,
        observation: S03SignalObservation,
        *,
        expected_epoch: int,
        expected_sequence: int,
    ) -> Reservation:
        try:
            return self._reserve_signal(
                owner,
                source,
                signal,
                observation,
                expected_epoch=expected_epoch,
                expected_sequence=expected_sequence,
            )
        except S03BridgeRejected as error:
            self._record_source_failure(owner, error.code)
            raise

    def _reserve_signal(
        self,
        owner: S03Owner,
        source: NativeFactsSource,
        signal: S03MarketSignal,
        observation: S03SignalObservation,
        *,
        expected_epoch: int,
        expected_sequence: int,
    ) -> Reservation:
        content = _sha(
            json.dumps(
                {
                    "signal_id": signal.signal_id,
                    "prefix": signal.prefix_sha256,
                    "close": signal.close,
                    "bar_close_ns": signal.bar_close_ns,
                },
                sort_keys=True,
            )
        )
        rejection: str | None = None
        with _immediate_transaction(self._c):
            self._auth(owner)
            run = self._run(owner.run_id)
            if int(run["recovery_reactivation"]) == 1:
                raise S03BridgeRejected("S03_RECOVERY_REACTIVATION_REQUIRED")
            rejection = self._entry_rejection(owner.run_id, signal)
        if rejection is not None:
            raise S03BridgeRejected(rejection)
        self._before_reserve_write()
        with _immediate_transaction(self._c):
            self._auth(owner)
            run = self._run(owner.run_id)
            if int(run["recovery_reactivation"]) == 1:
                raise S03BridgeRejected("S03_RECOVERY_REACTIVATION_REQUIRED")
            rejection = self._entry_rejection(owner.run_id, signal)
            if rejection is not None:
                raise S03BridgeRejected(rejection)
            plan, manifest = self._load(owner.run_id)
            validate_s03_signal(plan, signal, observation, manifest)
            prior = self._c.execute(
                "SELECT * FROM s03_signals WHERE run_id=? AND signal_id=?",
                (owner.run_id, signal.signal_id),
            ).fetchone()
            if prior is not None:
                if str(prior["content_sha256"]) != content:
                    raise S03BridgeRejected("S03_SIGNAL_CONFLICT")
                intent = self._c.execute(
                    "SELECT receipt_bytes FROM astarter_intents WHERE intent_id=?",
                    (prior["intent_id"],),
                ).fetchone()
                return Reservation(**json.loads(bytes(intent["receipt_bytes"])))
            account = self._c.execute(
                "SELECT * FROM astarter_accounts WHERE account_id=?",
                (run["account_id"],),
            ).fetchone()
            if (
                int(account["risk_epoch"]) != expected_epoch
                or int(account["last_sequence"]) != expected_sequence
            ):
                raise S03BridgeRejected("S03_RISK_EPOCH_CONFLICT")
            snap = self._snap(source)
            if not plan.starts_at_ns <= snap.now_ns < plan.expires_at_ns:
                raise S03BridgeRejected("S03_PLAN_EXPIRED")
            self._require_new_risk_inputs(owner.run_id, snap)
            self._astarter._observe_locked(snap)
            account = self._c.execute(
                "SELECT * FROM astarter_accounts WHERE account_id=?",
                (run["account_id"],),
            ).fetchone()
            policy, requested = s03_trade_terms(
                plan,
                signal,
                snap,
                locked_reserve=str(account["locked_reserve"]),
            )
            raw = policy_bytes(policy)
            policy_hash = hashlib.sha256(raw).hexdigest()
            binding = self._c.execute(
                "SELECT binding_id FROM astarter_bindings WHERE account_id=? AND "
                "component_id=? AND policy_sha256=? AND status='ACTIVE'",
                (run["account_id"], plan.parameters_sha256, policy_hash),
            ).fetchone()
            if binding is None:
                binding_id = str(uuid4())
                self._c.execute(
                    "INSERT INTO astarter_bindings VALUES(?,?,?,?,?,'ACTIVE')",
                    (binding_id, run["account_id"], plan.parameters_sha256, raw, policy_hash),
                )
            else:
                binding_id = str(binding["binding_id"])
            opportunity = Opportunity(
                signal.signal_id,
                signal.bar_close_ns,
                signal.expires_at_ns,
                requested,
            )
            reservation = self._astarter._reserve_locked(
                binding_id,
                opportunity,
                expected_epoch=int(account["risk_epoch"]),
                expected_sequence=int(account["last_sequence"]),
                fence=self._astarter.controller_identity.fence,
                owner=owner,
            )
            self._c.execute(
                "INSERT INTO s03_signals VALUES(?,?,?,?)",
                (owner.run_id, signal.signal_id, content, reservation.intent_id),
            )
            old_life = self._life(owner.run_id)
            self._save_life(
                owner.run_id,
                S03Life(
                    day_baseline=old_life.day_baseline,
                    day_key=old_life.day_key,
                    cooldown_open_after_ns=old_life.cooldown_open_after_ns,
                    reasons=tuple(r for r in old_life.reasons if not r.startswith("EXIT_RESULT:")),
                    active_intent_id=reservation.intent_id,
                ),
            )
            self._audit(
                owner.run_id,
                "S03_POSITION_STARTED",
                {
                    "intent_id": reservation.intent_id,
                    "previous_life": asdict(old_life),
                },
            )
            self._audit(owner.run_id, "S03_SIGNAL_RESERVED", {"signal_id": signal.signal_id})
            return reservation

    def claim_entry(self, owner: S03Owner, source: NativeFactsSource, order_id: str) -> object:
        try:
            return self._claim_entry(owner, source, order_id)
        except S03BridgeRejected as error:
            self._record_source_failure(owner, error.code)
            raise

    def _claim_entry(self, owner: S03Owner, source: NativeFactsSource, order_id: str) -> object:
        self._auth(owner)
        self._before_claim_write()
        with _immediate_transaction(self._c):
            self._auth(owner)
            snap = self._snap(source)
            self._require_new_risk_inputs(owner.run_id, snap)
            self._astarter._observe_locked(snap)
            self._validate_entry_claim_locked(owner, order_id, snap.now_ns)
            account = self._astarter._row(str(self._run(owner.run_id)["account_id"]))
            return self._astarter._claim_order_locked(
                order_id, fence=int(account["controller_fence"]), owner=owner
            )

    def _validate_entry_claim_locked(self, owner: S03Owner, order_id: str, now_ns: int) -> None:
        self._auth(owner)
        run = self._run(owner.run_id)
        if int(run["recovery_reactivation"]):
            raise S03BridgeRejected("S03_RECOVERY_REACTIVATION_REQUIRED")
        if now_ns >= int(run["expires_at_ns"]):
            raise S03BridgeRejected("S03_PLAN_EXPIRED")
        if s03_entry_locked(self._life(owner.run_id)):
            raise S03BridgeRejected("S03_NEW_RISK_LOCKED")
        match = self._c.execute(
            "SELECT 1 FROM s03_signals s JOIN astarter_orders o ON o.intent_id=s.intent_id "
            "WHERE s.run_id=? AND o.order_id=? AND o.role='ENTRY'",
            (owner.run_id, order_id),
        ).fetchone()
        if match is None:
            raise S03BridgeRejected("S03_ORDER_UNOWNED")

    def _observe_native_life_locked(self, run_id: str, snapshot: NativeSnapshot) -> None:
        plan, _ = self._load(run_id)
        life = self._life(run_id)
        scoped = self._position_snapshot(life, snapshot)
        life = step_s03_life(plan.parameters, scoped, None, life)
        life = advance_s03_time(
            life, plan.parameters, snapshot, snapshot.now_ns, plan.expires_at_ns
        )
        if life.exit_order_id is not None and "EXIT_PENDING" in life.reasons:
            native = next((o for o in snapshot.orders if o.order_id == life.exit_order_id), None)
            at_ns = native.state_time_ns if native else None
            updated = apply_s03_exit_fact(
                life,
                state=native.state if native else None,
                at_ns=at_ns if at_ns is not None else snapshot.now_ns,
                reconciled=snapshot.cash_reconciled and at_ns is not None,
            )
            if updated != life:
                self._audit(
                    run_id,
                    "S03_EXIT_RESULT",
                    {
                        "order_id": life.exit_order_id,
                        "state": native.state if native else "MISSING",
                        "native_at_ns": at_ns,
                    },
                )
            life = updated
        history = self._news_history(run_id)
        if not history or not self._news_clock(history[-1], snapshot.now_ns):
            life = replace(life, reasons=_with_reason(life.reasons, "NEWS_UNHEALTHY"))
        previous = self._life(run_id)
        for code in ("QUOTE_UNHEALTHY", "NEWS_UNHEALTHY"):
            if code in life.reasons and code not in previous.reasons:
                self._audit(run_id, f"S03_HEALTH_FAULT:{code}", {"at_ns": snapshot.now_ns})
        if "DAY_LOSS" in life.reasons and "DAY_LOSS" not in previous.reasons:
            self._audit(run_id, "S03_DAY_LOSS", {"day": life.day_key})
        self._save_life(run_id, life)

    def _position_snapshot(self, life: S03Life, snapshot: NativeSnapshot) -> NativeSnapshot:
        if life.active_intent_id is None:
            return replace(snapshot, orders=(), fills=())
        ids = {
            row[0]
            for row in self._c.execute(
                "SELECT order_id FROM astarter_orders WHERE intent_id=?", (life.active_intent_id,)
            )
        }
        return replace(
            snapshot,
            orders=tuple(o for o in snapshot.orders if o.order_id in ids),
            fills=tuple(f for f in snapshot.fills if f.order_id in ids),
        )

    def life(self, run_id: str) -> S03Life:
        return self._life(run_id)

    def apply_bar(
        self,
        owner: S03Owner,
        source: NativeFactsSource,
        observation: S03SignalObservation,
    ) -> S03Life:
        try:
            return self._apply_bar(owner, source, observation)
        except S03BridgeRejected as error:
            self._record_source_failure(owner, error.code)
            raise

    def _apply_bar(
        self,
        owner: S03Owner,
        source: NativeFactsSource,
        observation: S03SignalObservation,
    ) -> S03Life:
        if type(observation) is not S03SignalObservation:
            raise S03BridgeRejected("S03_OBSERVATION_INVALID")
        snap = self._snap(source)
        key = _sha(f"BAR:{observation.bar_close_ns}")
        rejected: str | None = None
        with _immediate_transaction(self._c):
            self._auth(owner)
            plan, manifest = self._load(owner.run_id)
            prior_bar = self._c.execute(
                "SELECT MAX(source_event_time_ns) FROM s03_events WHERE run_id=? AND kind='BAR'",
                (owner.run_id,),
            ).fetchone()[0]
            try:
                trusted = s03_match_observation(
                    plan,
                    manifest,
                    observation,
                    now_ns=snap.now_ns,
                    prior_bar_ns=None if prior_bar is None else int(prior_bar),
                )
            except S03BridgeRejected as error:
                self._remember_reason(owner.run_id, error.code)
                rejected = error.code
                trusted = None
            if trusted is not None:
                content = _sha(
                    json.dumps(
                        {
                            "bar_close_ns": trusted.bar_close_ns,
                            "available_at_ns": trusted.available_at_ns,
                            "prefix": trusted.prefix_sha256,
                            "revision": trusted.source_revision,
                            "close": trusted.close,
                            "ready": trusted.ready,
                            "gap": trusted.gap_reset,
                            "fast": trusted.snapshot.ema_fast,
                            "slow": trusted.snapshot.ema_slow,
                            "rsi": trusted.snapshot.rsi,
                            "atr": trusted.snapshot.atr,
                        },
                        sort_keys=True,
                    )
                )
                prior = self._c.execute(
                    "SELECT content_sha256 FROM s03_events WHERE run_id=? AND event_key=?",
                    (owner.run_id, key),
                ).fetchone()
                if prior is not None:
                    if str(prior["content_sha256"]) != content:
                        raise S03BridgeRejected("S03_EVENT_CONFLICT")
                    return self._life(owner.run_id)
                self._astarter._observe_locked(snap)
                if trusted.ready and not trusted.gap_reset:
                    current = self._life(owner.run_id)
                    self._save_life(
                        owner.run_id,
                        replace(
                            current, reasons=tuple(r for r in current.reasons if r != "DATA_PAUSE")
                        ),
                    )
                self._c.execute(
                    "INSERT INTO s03_events VALUES(?,?,?,?,?,?)",
                    (
                        owner.run_id,
                        key,
                        "BAR",
                        content,
                        trusted.bar_close_ns,
                        trusted.available_at_ns,
                    ),
                )
                life = step_s03_life(
                    plan.parameters,
                    self._position_snapshot(self._life(owner.run_id), snap),
                    trusted,
                    self._life(owner.run_id),
                )
                self._save_life(owner.run_id, life)
                self._audit(owner.run_id, "S03_BAR", {"bar_close_ns": trusted.bar_close_ns})
                self._after_bar(owner.run_id)
        if rejected is not None:
            raise S03BridgeRejected(rejected)
        return self._life(owner.run_id)

    def claim_exit(self, owner: S03Owner, source: NativeFactsSource, now_ns: int) -> S03Life:
        snap = self._snap(source)
        if type(now_ns) is not int or now_ns != snap.now_ns:
            raise S03BridgeRejected("S03_CLOCK_REGRESSION")
        with _immediate_transaction(self._c):
            self._auth(owner)
            self._astarter._observe_locked(snap)
            current = self._life(owner.run_id)
            if "EXIT_PENDING" in current.reasons or "RECONCILIATION_REQUIRED" in current.reasons:
                raise S03BridgeRejected("S03_EXIT_UNRESOLVED")
            intent = self._c.execute(
                "SELECT intent_id FROM s03_signals WHERE run_id=? AND intent_id=?",
                (owner.run_id, self._life(owner.run_id).active_intent_id),
            ).fetchone()
            if intent is None:
                raise S03BridgeRejected("S03_EXIT_UNAVAILABLE")
            self._astarter._request_exit_locked(str(intent["intent_id"]), owner)
            command = self._astarter._prepare_exit_locked(
                str(intent["intent_id"]), owner, allow_same_snapshot=True
            )
            if command is None:
                raise S03BridgeRejected("S03_EXIT_UNAVAILABLE")
            self._c.execute(
                "UPDATE astarter_orders SET dispatch_state='DISPATCHING' WHERE order_id=?",
                (command.order_id,),
            )
            life = claim_s03_exit(self._life(owner.run_id), now_ns, snap, command.order_id)
            self._save_life(owner.run_id, life)
            self._audit(owner.run_id, "S03_EXIT_CLAIM", {"order_id": command.order_id})
            return life

    def resolve_exit(self, owner: S03Owner, source: NativeFactsSource) -> S03Life:
        with _immediate_transaction(self._c):
            self._auth(owner)
            self._astarter._observe_locked(self._snap(source))
            return self._life(owner.run_id)

    def note_timer(self, owner: S03Owner, now_ns: int, *, source: NativeFactsSource) -> S03Life:
        if type(now_ns) is not int or now_ns < 0:
            raise S03BridgeRejected("S03_EXIT_INVALID")
        key = _sha(f"TIMER:{now_ns}")
        with _immediate_transaction(self._c):
            self._auth(owner)
            current = self._snap(source)
            run = self._run(owner.run_id)
            if (
                current.now_ns != now_ns
                or current.account_id != run["account_id"]
                or current.venue_session != run["venue_session"]
            ):
                raise S03BridgeRejected("S03_CLOCK_REGRESSION")
            prior = self._c.execute(
                "SELECT event_key FROM s03_events WHERE run_id=? AND event_key=?",
                (owner.run_id, key),
            ).fetchone()
            if prior is not None:
                return self._life(owner.run_id)
            watermark = self._c.execute(
                "SELECT MAX(received_time_ns) FROM s03_events WHERE run_id=? AND kind='TIMER'",
                (owner.run_id,),
            ).fetchone()[0]
            if watermark is not None and now_ns < watermark:
                raise S03BridgeRejected("S03_CLOCK_REGRESSION")
            account = str(self._run(owner.run_id)["account_id"])
            self._astarter._observe_locked(current)
            snapshot = self._astarter.stored_snapshot(account)
            if snapshot is None:
                raise S03BridgeRejected("S03_NATIVE_SOURCE_INVALID")
            covered, deadlines = F(0), []
            for row in self._c.execute(
                "SELECT intent_id FROM s03_signals WHERE run_id=? AND intent_id IS NOT NULL",
                (owner.run_id,),
            ).fetchall():
                intent_id = str(row[0])
                accepted = self._astarter._accepted_protection(intent_id, snapshot)
                covered += accepted
                first = self._astarter._uncovered_fill_time(intent_id, accepted)
                if first is not None:
                    intent = self._astarter._intent(intent_id)
                    _, policy = self._astarter._binding(intent["binding_id"], require_active=False)
                    deadlines.append(first + policy.protection_timeout_ns)
            plan, _ = self._load(owner.run_id)
            advanced = advance_s03_time(
                self._life(owner.run_id), plan.parameters, snapshot, now_ns, plan.expires_at_ns
            )
            history = self._news_history(owner.run_id)
            if not history or not self._news_clock(history[-1], now_ns):
                advanced = replace(
                    advanced, reasons=_with_reason(advanced.reasons, "NEWS_UNHEALTHY")
                )
            self._save_life(owner.run_id, advanced)
            life = note_s03_timer(
                advanced,
                now_ns,
                snapshot,
                protected_quantity=text(covered),
                uncovered_deadline_ns=min(deadlines) if deadlines else None,
            )
            if self._astarter._s03_command_timeouts(account, now_ns):
                life = replace(life, reasons=_with_reason(life.reasons, "RECONCILIATION_REQUIRED"))
            if "RECONCILIATION_REQUIRED" in life.reasons:
                self._astarter._set_locks(
                    account,
                    self._astarter._locks(self._astarter._row(account)) | {"RECONCILE_REQUIRED"},
                )
            if "PROTECTION_FAILED" in life.reasons:
                self._astarter._set_locks(
                    account,
                    self._astarter._locks(self._astarter._row(account)) | {"PROTECTION_FAILED"},
                )
            self._c.execute(
                "INSERT INTO s03_events VALUES(?,?,?,?,?,?)",
                (owner.run_id, key, "TIMER", key, now_ns, now_ns),
            )
            self._save_life(owner.run_id, life)
            self._audit(owner.run_id, "S03_TIMER", {"now_ns": now_ns})
            return life

    def claim_residual(self, owner: S03Owner, source: NativeFactsSource) -> S03Life:
        snap = self._snap(source)
        with _immediate_transaction(self._c):
            self._auth(owner)
            self._astarter._observe_locked(snap)
            life = claim_s03_residual(self._life(owner.run_id), snap)
            intent = self._c.execute(
                "SELECT intent_id FROM s03_signals WHERE run_id=? AND intent_id=?",
                (owner.run_id, self._life(owner.run_id).active_intent_id),
            ).fetchone()
            if intent is None:
                raise S03BridgeRejected("S03_RESIDUAL_UNAVAILABLE")
            receipt_row = self._c.execute(
                "SELECT receipt_bytes, entry_order_id FROM astarter_intents WHERE intent_id=?",
                (str(intent["intent_id"]),),
            ).fetchone()
            receipt = Reservation(**json.loads(bytes(receipt_row["receipt_bytes"])))
            intent_id = str(intent["intent_id"])
            stored_intent = self._astarter._intent(intent_id)
            _, policy = self._astarter._binding(stored_intent["binding_id"], require_active=False)
            self._astarter._latest(self._astarter._row(snap.account_id), policy.snapshot_ttl_ns)
            quantity = self._astarter._inventory(intent_id)
            if (
                not snap.cash_reconciled
                or quantity <= 0
                or quantity != amount(snap.position_quantity)
                or amount(snap.base_free) < quantity
                or amount(snap.bid) <= amount(receipt.stop)
                or self._astarter._locks(self._astarter._row(snap.account_id))
                & {"RECONCILE_REQUIRED", "NATIVE_INTEGRITY"}
                or any(
                    o.native_state not in {"FILLED", "CANCELED", "REJECTED", "DENIED", "EXPIRED"}
                    and o.dispatch_state != "CANCELED_LOCAL"
                    for o in self._astarter.orders(intent_id)
                )
            ):
                raise S03BridgeRejected("S03_RESIDUAL_UNAVAILABLE")
            order_id = str(receipt_row["entry_order_id"])[:-1] + "R"
            deadline = snap.now_ns + 1_000_000_000
            self._c.execute(
                "INSERT INTO astarter_orders(order_id,account_id,intent_id,role,quantity,"
                "trigger_price,deadline_ns) VALUES(?,?,?,'STOP',?,?,?)",
                (
                    order_id,
                    snap.account_id,
                    str(intent["intent_id"]),
                    text(quantity),
                    receipt.stop,
                    deadline,
                ),
            )
            life = replace(
                life,
                residual_order_id=order_id,
                residual_deadline_ns=deadline,
            )
            self._save_life(owner.run_id, life)
            self._audit(owner.run_id, "S03_RESIDUAL", {"used": True})
            return life

    def note_lock(self, owner: S03Owner, code: str) -> S03Life:
        with _immediate_transaction(self._c):
            self._auth(owner)
            life = lock_s03_reason(self._life(owner.run_id), code)
            self._save_life(owner.run_id, life)
            self._audit(owner.run_id, "S03_LOCK", {"code": code})
            return life

    def reactivation_binding(self, owner: S03Owner, reasons: tuple[str, ...]) -> str:
        self._auth(owner)
        if not reasons or len(set(reasons)) != len(reasons):
            raise S03BridgeRejected("S03_REACTIVATION_INVALID")
        old, _ = self._load(owner.run_id)
        run = self._run(owner.run_id)
        return digest(
            {
                "run_id": owner.run_id,
                "owner_id": owner.owner_id,
                "fence": owner.fence,
                "previous_review": old.review.seal,
                "reasons": sorted(reasons),
                "locks": self._life(owner.run_id).reasons,
                "recovery_reactivation": int(run["recovery_reactivation"]),
            }
        )

    def reactivate(
        self,
        owner: S03Owner,
        source: NativeFactsSource,
        plan: S03BridgePlan,
        manifest: S03DataManifest,
        *,
        reasons: tuple[str, ...],
    ) -> S03Life:
        validate_s03_plan(plan, manifest, local_simulation_case())
        allowed = {
            "RECOVERY_REACTIVATION_REQUIRED",
            "RECONCILIATION_REQUIRED",
            "PROTECTION_FAILED",
            "EXIT_BLOCKED",
            "EMERGENCY",
            "DAY_LOSS",
            "AUTH_REVOKED",
            "NEWS_LOCK",
            "PLAN_EXPIRED",
        }
        with _immediate_transaction(self._c):
            self._auth(owner)
            expected = self.reactivation_binding(owner, reasons)
            old, approved = self._load(owner.run_id)
            if (
                plan.review.reactivation_binding != expected
                or set(reasons) - allowed
                or plan.review.seal == old.review.seal
                or manifest != approved
                or plan.account_id != old.account_id
                or plan.group_id != old.group_id
                or plan.parameters != old.parameters
            ):
                raise S03BridgeRejected("S03_REACTIVATION_UNBOUND")
            snap = self._snap(source)
            if not plan.starts_at_ns <= snap.now_ns < plan.expires_at_ns:
                raise S03BridgeRejected("S03_PLAN_EXPIRED")
            self._qualify_quote_locked(owner.run_id, snap)
            self._astarter._observe_locked(snap)
            life = self._life(owner.run_id)
            run = self._run(owner.run_id)
            actual = set(life.reasons) | set(json.loads(bytes(run["reasons"])))
            if not set(reasons) <= actual:
                raise S03BridgeRejected("S03_REASON_ABSENT")
            account = self._astarter._row(snap.account_id)
            native = {o.order_id: o for o in snap.orders}
            unresolved = any(
                (r["dispatch_state"] in {"DISPATCHING", "OBSERVED"} and r["order_id"] not in native)
                or (
                    r["cancel_requested"]
                    and (
                        r["order_id"] not in native
                        or native[r["order_id"]].state
                        not in {"FILLED", "CANCELED", "REJECTED", "DENIED", "EXPIRED"}
                    )
                )
                for r in self._c.execute(
                    "SELECT * FROM astarter_orders WHERE account_id=?", (snap.account_id,)
                )
            )
            if (
                not snap.cash_reconciled
                or snap.base_total != snap.position_quantity
                or unresolved
                or self._astarter._locks(account) & {"RECONCILE_REQUIRED", "NATIVE_INTEGRITY"}
            ):
                raise S03BridgeRejected("S03_REPAIR_UNPROVEN")
            covered = sum(
                (
                    self._astarter._accepted_protection(str(r[0]), snap)
                    for r in self._c.execute(
                        "SELECT intent_id FROM s03_signals WHERE run_id=?", (owner.run_id,)
                    )
                ),
                F(0),
            )
            terminal = all(
                o.state in {"FILLED", "CANCELED", "REJECTED", "DENIED", "EXPIRED"}
                for o in snap.orders
            )
            flat = amount(snap.position_quantity) == 0 and terminal
            history = self._news_history(owner.run_id)
            if not history or not self._news_clock(history[-1], snap.now_ns):
                raise S03BridgeRejected("S03_NEWS_UNHEALTHY")
            for code in reasons:
                if code == "PROTECTION_FAILED" and not (
                    flat
                    or (
                        amount(snap.position_quantity) > 0
                        and covered >= amount(snap.position_quantity)
                    )
                ):
                    raise S03BridgeRejected("S03_REPAIR_UNPROVEN")
                if code == "EXIT_BLOCKED" and not flat:
                    raise S03BridgeRejected("S03_REPAIR_UNPROVEN")
                if code in {"EMERGENCY", "AUTH_REVOKED", "DAY_LOSS"} and not flat:
                    raise S03BridgeRejected("S03_REPAIR_UNPROVEN")
                if code == "DAY_LOSS":
                    loss = self._c.execute(
                        "SELECT fact_bytes FROM s03_audit WHERE run_id=? AND "
                        "kind='S03_DAY_LOSS' ORDER BY seq DESC LIMIT 1",
                        (owner.run_id,),
                    ).fetchone()
                    if (
                        loss is None
                        or json.loads(bytes(loss[0]))["day"] == life.day_key
                        or "DAY_BASELINE_MISSING" in life.reasons
                    ):
                        raise S03BridgeRejected("S03_REPAIR_UNPROVEN")
                if code == "NEWS_LOCK":
                    incidents = {
                        r.split(":", 1)[1] for r in life.reasons if r.startswith("NEWS_INCIDENT:")
                    }
                    if not incidents:
                        incidents = {"manual"}
                    for incident in incidents:
                        facts = [n for n in history if n.incident_id == incident]
                        if not facts or facts[-1].status != "CLEARED":
                            raise S03BridgeRejected("S03_REPAIR_UNPROVEN")
            if set(reasons) & {"RECONCILIATION_REQUIRED", "RECOVERY_REACTIVATION_REQUIRED"}:
                for claim in self._c.execute(
                    "SELECT fact_bytes,fact_sha256,kind FROM astarter_audit WHERE account_id=? "
                    "AND kind IN ('NATIVE_DISPATCH_CLAIMED','NATIVE_CANCEL_INTENT')",
                    (snap.account_id,),
                ).fetchall():
                    raw, hashed = bytes(claim[0]), str(claim[1])
                    if hashlib.sha256(raw).hexdigest() != hashed:
                        raise S03BridgeRejected("S03_AUDIT_INVALID")
                    event = json.loads(raw)
                    order = native.get(event["order_id"])
                    registered = self._c.execute(
                        "SELECT intent_id,role FROM astarter_orders "
                        "WHERE account_id=? AND order_id=?",
                        (snap.account_id, event["order_id"]),
                    ).fetchone()
                    accepted_stop = (
                        claim[2] == "NATIVE_DISPATCH_CLAIMED"
                        and registered is not None
                        and registered["role"] == "STOP"
                        and order is not None
                        and order.state in {"ACCEPTED", "PARTIALLY_FILLED"}
                        and order.accepted_at_ns is not None
                        and order.accepted_at_ns <= snap.now_ns
                        and self._astarter._inventory(str(registered["intent_id"])) > 0
                        and self._astarter._accepted_protection(str(registered["intent_id"]), snap)
                        >= self._astarter._inventory(str(registered["intent_id"]))
                    )
                    if (
                        order is not None
                        and order.state
                        in {
                            "FILLED",
                            "CANCELED",
                            "REJECTED",
                            "DENIED",
                            "EXPIRED",
                        }
                        or accepted_stop
                    ):
                        assert order is not None
                        self._astarter._audit(
                            snap.account_id,
                            "S03_COMMAND_RECONCILED",
                            {
                                "claim_sha256": hashed,
                                "order_id": order.order_id,
                                "native_state": order.state,
                                "native_at_ns": order.state_time_ns,
                                "accepted_at_ns": order.accepted_at_ns,
                                "reconciled_time_ns": snap.now_ns,
                                "review_binding": expected,
                            },
                        )
                if self._astarter._s03_command_timeouts(snap.account_id, snap.now_ns):
                    raise S03BridgeRejected("S03_REPAIR_UNPROVEN")
                pending = native.get(life.exit_order_id or "")
                if (
                    "RECONCILIATION_REQUIRED" in reasons
                    and pending is not None
                    and pending.state in {"FILLED", "CANCELED", "REJECTED", "DENIED", "EXPIRED"}
                ):
                    life = replace(
                        life,
                        exit_order_id=None,
                        reasons=_with_reason(
                            tuple(r for r in life.reasons if r != "EXIT_PENDING"),
                            f"EXIT_RESULT:{pending.state}",
                        ),
                    )
            retained = tuple(
                r
                for r in life.reasons
                if r not in reasons
                and not ("NEWS_LOCK" in reasons and r.startswith("NEWS_INCIDENT:"))
            )
            life = replace(life, reasons=retained)
            self._save_life(owner.run_id, life)
            run_reasons = tuple(r for r in json.loads(bytes(run["reasons"])) if r not in reasons)
            recovery = (
                0
                if "RECOVERY_REACTIVATION_REQUIRED" in reasons
                else int(run["recovery_reactivation"])
            )
            self._c.execute(
                "UPDATE s03_runs SET reasons=?,recovery_reactivation=?,starts_at_ns=?,"
                "expires_at_ns=? "
                "WHERE run_id=?",
                (
                    encode(list(run_reasons)),
                    recovery,
                    plan.starts_at_ns,
                    plan.expires_at_ns,
                    owner.run_id,
                ),
            )
            self._c.execute(
                "UPDATE s03_plan_manifest SET plan_json=? WHERE run_id=?",
                (json.dumps(plan.model_dump(mode="json"), sort_keys=True), owner.run_id),
            )
            if "PROTECTION_FAILED" in reasons:
                self._astarter._set_locks(
                    snap.account_id, self._astarter._locks(account) - {"PROTECTION_FAILED"}
                )
            self._audit(
                owner.run_id,
                "S03_REACTIVATED",
                {
                    "reasons": reasons,
                    "review_binding": expected,
                    "previous_plan": old.model_dump(mode="json"),
                    "new_review": plan.review.seal,
                    "native_sequence": snap.sequence,
                },
            )
            return life

    def release_reason(self, owner: S03Owner, code: str) -> S03Life:
        with _immediate_transaction(self._c):
            self._auth(owner)
            life = release_s03_reason(self._life(owner.run_id), code)
            self._save_life(owner.run_id, life)
            self._audit(owner.run_id, "S03_RELEASE", {"code": code})
            return life

    def _before_reserve_write(self) -> None:
        return None

    def _before_claim_write(self) -> None:
        return None

    def _after_bar(self, run_id: str) -> None:
        return None

    def _snap(self, source: NativeFactsSource) -> NativeSnapshot:
        if type(source) is not NativeFactsSource:
            raise S03BridgeRejected("S03_SOURCE_UNTRUSTED")
        try:
            snap = source.capture()
            source.verify(snap)
            s03_bound_source_event_time(snap)
        except (AstarterIntegrityError, S03BridgeRejected) as error:
            raise S03BridgeRejected("S03_SOURCE_UNTRUSTED") from error
        return snap

    def _entry_rejection(self, run_id: str, signal: S03MarketSignal) -> str | None:
        life = self._life(run_id)
        if life.blocked_signal_id is not None and signal.signal_id == life.blocked_signal_id:
            return "S03_SIGNAL_BLOCKED"
        if (
            life.cooldown_open_after_ns is not None
            and signal.bar_close_ns <= life.cooldown_open_after_ns
        ):
            return "S03_COOLDOWN_SIGNAL"
        if s03_entry_locked(life):
            if life.blocked_signal_id is None:
                self._c.execute(
                    "UPDATE s03_lifecycle SET blocked_signal_id=? WHERE run_id=?",
                    (signal.signal_id, run_id),
                )
            return "S03_NEW_RISK_LOCKED"
        return None

    def _life(self, run_id: str) -> S03Life:
        self._run(run_id)
        row = self._c.execute("SELECT * FROM s03_lifecycle WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise S03BridgeRejected("S03_RUN_NOT_FOUND")
        loaded = json.loads(bytes(row["reasons"]))
        if type(loaded) is not list:
            raise S03BridgeRejected("S03_LIFE_INVALID")
        reasons = tuple(str(item) for item in loaded)
        open_after: int | None = None
        exit_order: str | None = None
        residual_order: str | None = None
        residual_deadline: int | None = None
        active_intent: str | None = None
        visible: list[str] = []
        for reason in reasons:
            if reason.startswith("ACTIVE_INTENT:"):
                active_intent = reason.split(":", 1)[1]
            elif reason.startswith("COOLDOWN_OPEN_AFTER:"):
                open_after = int(reason.split(":", 1)[1])
            elif reason.startswith("EXIT_ORDER:"):
                exit_order = reason.split(":", 1)[1]
            elif reason.startswith("RESIDUAL_ORDER:"):
                residual_order = reason.split(":", 1)[1]
            elif reason.startswith("RESIDUAL_DEADLINE:"):
                residual_deadline = int(reason.split(":", 1)[1])
            else:
                visible.append(reason)
        if active_intent is None:
            active = self._c.execute(
                "SELECT s.intent_id FROM s03_signals s JOIN astarter_intents i ON "
                "i.intent_id=s.intent_id "
                "WHERE s.run_id=? AND i.state NOT IN ('CLOSED','NO_FILL')",
                (run_id,),
            ).fetchall()
            if len(active) == 1:
                active_intent = str(active[0][0])
            elif len(active) > 1:
                raise S03BridgeRejected("S03_ACTIVE_INTENT_CONFLICT")
        return S03Life(
            first_fill_ns=_opt_int(row["first_fill_ns"]),
            rsi_fail_streak=int(row["rsi_fail_streak"]),
            hold_seen=int(row["hold_seen"]),
            cooldown_bars=int(row["cooldown_bars"]),
            flat_ns=_opt_int(row["flat_ns"]),
            exit_claims=int(row["exit_claims"]),
            last_exit_ns=_opt_int(row["last_exit_ns"]),
            exit_deadline_ns=_opt_int(row["exit_deadline_ns"]),
            protection_deadline_ns=_opt_int(row["protection_deadline_ns"]),
            residual_used=bool(int(row["residual_used"])),
            day_baseline=None if row["day_baseline"] is None else str(row["day_baseline"]),
            day_key=None if row["day_key"] is None else str(row["day_key"]),
            exit_target=None if row["exit_target"] is None else str(row["exit_target"]),
            blocked_signal_id=None
            if row["blocked_signal_id"] is None
            else str(row["blocked_signal_id"]),
            reasons=tuple(visible),
            cooldown_open_after_ns=open_after,
            exit_order_id=exit_order,
            residual_order_id=residual_order,
            residual_deadline_ns=residual_deadline,
            active_intent_id=active_intent,
        )

    def _remember_reason(self, run_id: str, code: str) -> None:
        life = self._life(run_id)
        gate = (
            "NEWS_UNHEALTHY"
            if code.startswith("S03_NEWS_")
            else (
                "DATA_PAUSE"
                if code.startswith(("S03_OBSERVATION_", "S03_BAR_"))
                else "SOURCE_UNTRUSTED"
            )
        )
        if gate not in life.reasons:
            snap = self._astarter.stored_snapshot(str(self._run(run_id)["account_id"]))
            self._audit(run_id, f"S03_HEALTH_FAULT:{gate}", {"at_ns": snap.now_ns if snap else 0})
        reasons = _with_reason(_with_reason(life.reasons, code), gate)
        self._save_life(run_id, replace(life, reasons=reasons))
        self._audit(run_id, "S03_SOURCE_REJECTED", {"code": code})

    def _save_life(self, run_id: str, life: S03Life) -> None:
        reasons = tuple(
            reason
            for reason in life.reasons
            if not reason.startswith(
                (
                    "COOLDOWN_OPEN_AFTER:",
                    "EXIT_ORDER:",
                    "RESIDUAL_ORDER:",
                    "RESIDUAL_DEADLINE:",
                    "ACTIVE_INTENT:",
                )
            )
        )
        if life.active_intent_id is not None:
            reasons = _with_reason(reasons, f"ACTIVE_INTENT:{life.active_intent_id}")
        if life.cooldown_open_after_ns is not None:
            reasons = _with_reason(reasons, f"COOLDOWN_OPEN_AFTER:{life.cooldown_open_after_ns}")
        if life.exit_order_id is not None:
            reasons = _with_reason(reasons, f"EXIT_ORDER:{life.exit_order_id}")
        if life.residual_order_id is not None:
            reasons = _with_reason(reasons, f"RESIDUAL_ORDER:{life.residual_order_id}")
        if life.residual_deadline_ns is not None:
            reasons = _with_reason(reasons, f"RESIDUAL_DEADLINE:{life.residual_deadline_ns}")
        self._c.execute(
            "UPDATE s03_lifecycle SET first_fill_ns=?, rsi_fail_streak=?, hold_seen=?, "
            "cooldown_bars=?, flat_ns=?, exit_claims=?, last_exit_ns=?, exit_deadline_ns=?, "
            "protection_deadline_ns=?, residual_used=?, day_baseline=?, day_key=?, "
            "exit_target=?, blocked_signal_id=?, reasons=? WHERE run_id=?",
            (
                life.first_fill_ns,
                life.rsi_fail_streak,
                life.hold_seen,
                life.cooldown_bars,
                life.flat_ns,
                life.exit_claims,
                life.last_exit_ns,
                life.exit_deadline_ns,
                life.protection_deadline_ns,
                1 if life.residual_used else 0,
                life.day_baseline,
                life.day_key,
                life.exit_target,
                life.blocked_signal_id,
                encode(list(reasons)),
                run_id,
            ),
        )

    def _auth(self, owner: S03Owner) -> None:
        if type(owner) is not S03Owner:
            raise S03BridgeRejected("S03_OWNER_INVALID")
        row = self._run(owner.run_id)
        self._astarter._writer(str(row["account_id"]))
        if (
            row["status"] != "ACTIVE"
            or int(row["fence"]) != owner.fence
            or str(row["owner_id"]) != owner.owner_id
            or str(row["credential_sha256"]) != _sha(owner.credential)
            or str(row["venue_session"]) != owner.venue_session
        ):
            raise S03BridgeRejected("S03_OWNER_STALE")

    def _run(self, run_id: str) -> Any:
        row = self._c.execute("SELECT * FROM s03_runs WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise S03BridgeRejected("S03_RUN_NOT_FOUND")
        self._scope(str(row["account_id"]), str(row["venue_session"]))
        return row

    def _scope(self, account_id: str, venue_session: str) -> None:
        self._astarter._access.scope(account_id)
        self._astarter._access.check_source(account_id, venue_session)
        head = self._astarter._admission.head(self._astarter.controller_identity)
        if head["purpose"] != "LEGACY_FINITE" or head["authority_id"] != S03_FINITE_AUTHORITY:
            raise S03BridgeRejected("S03_FINITE_AUTHORITY_REQUIRED")

    def _load(self, run_id: str) -> tuple[S03BridgePlan, S03DataManifest]:
        row = self._c.execute(
            "SELECT plan_json, manifest_json FROM s03_plan_manifest WHERE run_id=?",
            (run_id,),
        ).fetchone()
        if row is None:
            raise S03BridgeRejected("S03_PLAN_MISSING")
        plan_payload = json.loads(row["plan_json"])
        plan_payload["capabilities"] = tuple(plan_payload["capabilities"])
        plan_payload["review"]["duties"] = tuple(plan_payload["review"]["duties"])
        manifest_payload = json.loads(row["manifest_json"])
        manifest_payload["quotes"] = tuple(manifest_payload["quotes"])
        manifest_payload["bars"] = tuple(manifest_payload["bars"])
        manifest_payload["news"] = tuple(manifest_payload.get("news", ()))
        plan = S03BridgePlan.model_validate(plan_payload)
        manifest = S03DataManifest.model_validate(manifest_payload)
        validate_s03_plan(plan, manifest, local_simulation_case())
        run = self._run(run_id)
        if (
            run["manifest_sha256"] != plan.manifest_sha256
            or run["plan_sha256"] != plan.parameters_sha256
        ):
            raise S03BridgeRejected("S03_PLAN_MISMATCH")
        return plan, manifest

    def _state(self, row: Any) -> S03RunState:
        reasons = tuple(json.loads(bytes(row["reasons"])))
        run_id = str(row["run_id"])
        return S03RunState(
            run_id=run_id,
            owner_id=str(row["owner_id"]),
            fence=int(row["fence"]),
            venue_session=str(row["venue_session"]),
            input_reasons=reasons,
            accepted_quote_count=int(
                self._c.execute(
                    "SELECT COUNT(*) FROM s03_events WHERE run_id=? AND kind='QUOTE'",
                    (run_id,),
                ).fetchone()[0]
            ),
            rejected_count=int(
                self._c.execute(
                    "SELECT COUNT(*) FROM s03_audit WHERE run_id=? AND kind='S03_SOURCE_REJECTED'",
                    (run_id,),
                ).fetchone()[0]
            ),
            quote_source_watermark=None
            if row["quote_watermark"] is None
            else int(row["quote_watermark"]),
            quote_source_event_watermark_ns=None
            if row["quote_event_ns"] is None
            else int(row["quote_event_ns"]),
            instrument_sha256=str(row["manifest_sha256"]),
            profile_version="S03_SIM_BTC_QUOTE_V1",
        )

    def _audit(self, run_id: str, kind: str, fact: object) -> None:
        seq = self._c.execute(
            "SELECT COALESCE(MAX(seq),0)+1 FROM s03_audit WHERE run_id=?",
            (run_id,),
        ).fetchone()[0]
        raw = encode(fact)
        self._c.execute(
            "INSERT INTO s03_audit VALUES(?,?,?,?,?)",
            (run_id, seq, kind, raw, hashlib.sha256(raw).hexdigest()),
        )


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def manifest_digest(manifest: S03DataManifest) -> str:
    return s03_manifest_sha256(manifest)


def _opt_int(value: Any) -> int | None:
    if value is None:
        return None
    return int(value)


def _with_reason(reasons: tuple[str, ...], code: str) -> tuple[str, ...]:
    return reasons if code in reasons else reasons + (code,)
