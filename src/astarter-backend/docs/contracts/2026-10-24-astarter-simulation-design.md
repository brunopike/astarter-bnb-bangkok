# Astarter finite native simulation: design and ownership

User authorized implementation of an Astarter simulation flow covering concurrent reservations, profit-lock deduplication, restart recovery and order protection, plus one BTC trade. Main thread verified that authorization and leased an isolated branch based on Q03 `4c0057e9f36ccbb490c9ca50d13750e30a7e1164`. This is a finite local native simulation, not continuous PAPER/Q07, live trading, a profitable strategy claim or a public HTTP contract.

## Approaches and decision

1. Reuse the authoritative Control SQLite connection and `BEGIN IMMEDIATE`, append Astarter risk/order facts and derive amounts from actual native execution. Selected: gives real inter-process atomicity and persisted recovery without a second balance or run database.
2. Separate risk.sqlite or an in-memory trading ledger. Rejected: cannot atomically establish the requested authority in the existing Control boundary and could misleadingly pass recovery with a shadow balance.
3. Immediately widen all existing run kinds, HTTP/protocol/scheduler/consumers. Deferred to main: a large compatibility change is unnecessary to prove this closed finite native flow and would conflict with its current consumer slice.

The implementation choice is ours within the user’s authorized scope; main reviews the shared migration lease before changes. No additional user approval is needed for these local implementation details.

## Ownership and proposed shared delta

Exclusive new code: `domain/astarter_simulation*.py`, `control/astarter/`, `runner/astarter_*.py`; dedicated unit/integration/compat tests; `astarter-simulation-*` docs. Original Q03 goldens and old S03/SMA remain intact.

Shared delta approved by main after full internal design review:

- `control/database.py`: register schema6 resource, safe v5→v6 bootstrap, extend version/preflight races, schema fingerprint and old-writer rejection. Reuse `_immediate_transaction`; do not weaken durability or existing guards.
- New `control/migrations/006_astarter_simulation.sql`: risk tables and schema6 writer guards, retain existing tables/data/identities. Never rewrite migrations001–005.
- Version-sensitive assertions in `tests/unit/control/test_database.py`, plus new dedicated migration tests and exact version assertions in the historical-control/configuration migration tests (separate explicit main lease). Preserve expected old versions in rollback/failure tests.

No ControlStore hook is needed initially: internal `AstarterControl(store: ControlStore)` uses the existing connection and transaction primitive, as existing internal components do. Do not modify registry.py, transactions.py, routes, OpenAPI, historical protocol, scheduler or shared task indexes. No new run-status database/table. A binding’s `component_id` is the hash of a closed finite native manifest and identifies provenance only; it is not an old PROBE/SMA authorization or a public run contract. Main owns eventual registration in the public run pipeline.

## Closed input and fact boundary

- Fixed identity `ASTARTER_BTC_NATIVE_SIM_V1`, `BTC/USDT.SIM`, CASH/NETTING, quote USDT8/base BTC5, starting native cash10000USDT, both fees .001, no borrowing or network/live adapter.
- Explicit canonical manifest bytes/hash, immutable policy and activation record, private account binding and nonexpanding hard limits. Changing account/policy/data/cost invalidates the binding; copied public rules do not copy it.
- Q03 remains a pure math dependency. Stage and seven-scope budgets precede sizing. Candidates are not receipts and cannot authorize orders on their own.
- Only the internal native adapter can supply execution facts: actual cached account totals/free/locked, owned order states, positions, `OrderFilled` trade IDs/fees and accepted stop IDs. Never use floats or test-computed fills as runtime balances/PnL.
- Native quote total already reflects filled spending. Pending cash occupancy applies only to still possible unfilled quantities. Do not subtract native locked cash and an equivalent ledger hold twice. Unknown/unowned or inconsistent native facts stop new risk.
- Snapshot/sequence/hash/observed-time are persisted provenance, not a second mutable wallet. Outside the native adapter no caller-supplied cash, PnL, flat=True or accepted=True is trusted as proof.

## Persistent model in the same Control database

Tables are anchored to stable native simulated account identity, not component/strategy/manifest aliases. A changed binding cannot reset epoch, HWM/reserve, loss period, seven caps, booked losses or outstanding occupancy. Same account+different initial native baseline conflicts; one native venue session/fact provider per account. Proposed tables:

- `astarter_accounts`: stable native account PK; unique native venue session and immutable initial native baseline; monotonic risk_epoch/controller fence, loss period, persistent locks, settlement HWM/reserve and latest attested provenance. No wallet transfer, second cash authority or duplicate run lifecycle.
- `astarter_bindings`: immutable manifest/policy/account references and bounded activation identity; all bindings point to the same account-level risk state. Same source under another component does not create another wallet or reset limits.
- `astarter_limits`: explicit seven scope caps and booked-loss debits. Occupancy is derived from pending/intents and confirmed inventory, not client totals; asset/correlation/event keys cannot be reset by renaming strategy.
- `astarter_intents`: unique economic opportunity key, request hash, quantity/cap/stress/stop/fees, immutable receipt, disjoint pending vs inventory pressure, cash hold, dispatch state and deterministic native entry ID. Reservation and dispatch intent are committed together.
- `astarter_orders`: deterministic role/ID, protected quantity, native state/sequence and terminal evidence. Cancel intent alone is never terminal proof. At most one competing exit target; no oversell.
- `astarter_fills`: append-only dedupe key `(account, native order ID, native trade ID)` and exact immutable fill/commission facts.
- `astarter_settlements`: unique native economic close identity, immutable source digest, closed fill coverage/native flat/terminal reconciliation facts and lock increment. Same close under another request ID cannot lock twice; different payload for same identity is conflict.
- `astarter_audit`: ordered append-only facts and reason codes. No secret/model/API key data.

Every mutation uses one existing `BEGIN IMMEDIATE`, rereads current epoch/locks/private binding, computes with exact Q03/Fraction and updates epoch. Unique constraints and SQL triggers supplement Python validation. No monetary SQLite REAL/NUMERIC coercion. Old processes must be unable to write after schema upgrade.

Native fact envelopes are sealed by a runtime-only opaque adapter capability, bound to its actual native venue/session, account, sequence and time. Replacing fields or importing caller-made snapshots cannot recover authority. Persist session/sequence/provenance; a new independent engine with the same account ID cannot impersonate the old venue. No callback/network wait is held inside a SQLite write transaction.

## Reservation and lifecycle

1. Validate current binding, fresh authoritative native snapshot, opportunity absolute TTL and expected risk_epoch. Same opportunity+same canonical request returns its receipt without new dispatch; same key+different request conflicts. Reservation races on one account must serialize/CAS and enforce all scopes and cash.
2. Commit immutable receipt, pending risk/cash and deterministic entry ID before native submission. Before sending, atomically mark dispatch ambiguous/inflight. A crash on either side of send never permits blind resend. Recovery returns reconcile-required, retains the hold and rejects new risk.
3. LIMIT IOC native entry: persist every native fill idempotently. Transfer confirmed exposure from pending to inventory pressure; retain unresolved remainder until an actual terminal native order/snapshot proves it gone. Zero fill still consumes the economic opportunity.
4. On each partial fill, immediately submit a deterministic STOP_MARKET SELL for confirmed sellable inventory, with supported native trigger semantics. Pending stop is not protection accepted; rejected/missing/late stop hard-halts new risk and requests reconciliation/approved reduction without pretending flat.
5. Exit coordination: freeze a target inventory, cancel/reconcile competing stop or entry before another sale where needed; never sell above confirmed sellable quantity. A halt on new entries does not veto an already-approved protective reduction. Native stop trigger and emergency exit have distinct IDs and audit reasons.
6. Reconcile actual native cash, open orders and positions after native settle. Only flat, all owned orders terminal, complete native fills and fees permit a unique settlement. Compute net profit from native results/account delta at settlement, not a forecast; apply Q03 HWM logic and commit settlement+reserve+HWM atomically.

## Recovery semantics

- Reopen the same Control database in a fresh process; schema/integrity/configuration gates still apply. Persisted hard locks and risk period are not reset by restart, day changes, rising prices, deposits or HWM recovery.
- Persisted intent/stop IDs are compared with an authoritative native broker snapshot. Do not auto-dispatch stale opportunities or release UNKNOWN holds. Missing native data remains reconciliation-required; not-found without complete account/order evidence is not proof of no fill.
- Positive recovery test separates controller restart from the native simulated venue: the venue can keep an accepted stop while a fresh controller reconnects. Also run a real child-process reopen/crash test against the same SQLite state. This is not a claim that a destroyed BacktestEngine is restored in place or that protection survives a real machine power loss.
- Native engine destruction requires an explicitly verified replay/reconstruction before any further action; unsupported restoration fails closed. Q07 continuous venue/process/disconnection proof remains separate.

## BTC golden trajectory (synthetic, actually executed locally)

Native balance10000USDT; Q03 frozen cap60120, stress58882, stop59000, risk5, step.00001, quote unit.00000001 gives q.00368, risk4.99377472 and reserve221.46284528. Entry market60000 yields native spend220.8 and fee.2208 if the pinned engine matches that price. The executed approved close at61000 yields224.48 less.22448 fee: net3.23472, gross10003.23472, new logical lock.646944 and tradable10002.587776. These are independent expected literals, conditional on actual native execution; tests must not manufacture those fills.

Distinct native cases: zero IOC fill; forced partial entry+immediate stop; stop trigger; accepted stop surviving controller recovery; protective rejection/timeout retaining inventory; competing exits; duplicate/out-of-order events; causal price event order. If pinned rc3 cannot establish a capability, reject that case/activation rather than label it protected.

## Acceptance and evidence

- Separate-process same-account contention at a500 cap/490 booked/10 request admits exactly one; stale epoch conflicts and retry rechecks; canonical duplicate has no new intent/send.
- Actual native profit3.23472 over HWM0 locks.646944 once (Q03 math vectors remain unchanged); duplicate economic settlement under changed request ID locks0, conflicting replay rejects; loss/recovery does not lower HWM or release reserve; no settled proof means no lock.
- Kill/reopen around reservation/send/fill/settlement preserves audit, occupancy, hard locks and dedupe. Neither time nor restart refills the period or dispatches old work.
- Actual native reports prove BTC quantity, fees, account totals, order acceptance/terminal states and protective trigger. Collect raw native facts before engine disposal; independently verify cash and no open/unprotected inventory on the successful path.
- Targeted TDD RED→GREEN, migration/legacy regression, strict mypy/Ruff, fixed-source full Engine suite, one independent final review; reproduce/fix material findings and rerun affected gates. Main receives fixed commit(s), schema compatibility notes, commands, hashes, native trace and unresolved limitations before selective integration.

Official sequencing reference: https://nautilustrader.io/docs/latest/concepts/backtesting/execution-flow/ . Runtime truth is the locally locked `nautilus_trader==2.0.0rc3` API and actual compatibility tests, not unverified latest-doc behavior.


## Final accounting and reduction rulings

- Persisted `booked_debit` is cumulative closed negative native net PnL; winning trades never reduce historical debits. Before close, paid native fees plus adverse native cost-to-current-bid movement remain a temporary open provision. Q03 receives closed debit + open provision + current-bid-to-stress inventory risk + pending risk. Successful settlement atomically replaces open provision with the exact negative net loss, preventing duplicate fee charging and preserving losses during partial closes.
- EXIT target stays zero. A proven PENDING/never-claimed exit can be reconstructed after controller recovery. DISPATCHING/unknown cannot be resent. A terminal partial/zero-fill IOC permits a new deterministic child only after a newer native timestamp; durable `last_exit_attempt_ns` prevents same-tick feedback loops. Every child rechecks current native free base and remaining owned quantity.
- A stop deadline is anchored to the earliest actually uncovered BUY fill, including after recovery. Acceptance exactly at the deadline is valid; same-timestamp pending native callbacks are allowed to settle before strict timeout. Late/rejected/unexpectedly removed protection hard-halts new risk. A canceled stop followed by approved market reduction is separately audited, not described as uninterrupted protection.
- Current acceptance remains finite internal simulation. Restarting only the controller with a surviving native venue/source is supported. Complete venue destruction, continuous PAPER/Q07, public run/HTTP registration, external data/account/model connections and live orders remain unverified.


## Independent-review repairs (candidate388acbd was rejected)

The fresh whole-branch reviewer reproduced three material windows. Dedicated native tests fail against388acbd and cover the repaired implementation:

1. Prepared/unclaimed STOP recovery: resume the same PENDING command within its original fill-based deadline; during an approved close cancel it locally without a venue cancel. Unknown DISPATCHING remains reserved and cannot be resent/canceled merely because not in cache. A late unclaimed stop hard-halts and then reduces after reconciliation; no resetting the deadline.
2. Shared HWM lock parameter: the first native account activation freezes `lock_fraction` as an immutable account column. Alias policy with a different value is rejected before activation/zero-fill opportunity. Settlement uses that account value, never the latest intent's policy.
3. Reduction dispatch: claim rechecks fresh authoritative cash/position/fill/order evidence under the write transaction, rejects RECONCILE_REQUIRED/NATIVE_INTEGRITY, checks owned remaining inventory, free native base and competing sell commands, plus actual closing/protection state. DAY_LOSS/DRAWDOWN do not alone veto a valid frozen reduction. Runner refreshes its controller fence after a dispatch/recovery callback boundary.

Schema6 remains an unpublished candidate migration. Only temporary candidate databases were created; older388acbd diagnostic databases are evidence, not reusable live runtime state. Main current schema5 is the integration starting point.

## Exit retry and S03 boundary

The finite runner has ten strictly increasing synthetic quote timestamps. Each intent can create at most one new EXIT child per fresh native time, with the previous command proven terminal and the remaining quantity freshly reconciled; same-tick feedback loops and ambiguous resend are blocked. This is not S03's eventual total-attempt/cooldown policy. There is currently no standalone persistent three-attempt/global-duration setting in this internal component. Main must freeze those strategy parameters when wiring S03/public runs, rather than infer S03 acceptance from these local results. Exhausted data or unknown execution leaves explicit reconciliation-required state, not a fabricated flat/complete result.


## Main integration review: A1/A2 amendments

Main independently reproduced known integrity failure removing an accepted stop before a forbidden exit, and short frozen TTLs being relaxed by default5s. Both are required repairs, not default-only exceptions. Cancellation now gates source trust/own frozen policy under its transaction before native action; runner rechecks at callbacks. Never require post-cancel free base before cancellation. DAY_LOSS/DRAWDOWN remain distinct from NATIVE_INTEGRITY/RECONCILE_REQUIRED; local never-claimed withdrawal remains safe.

Every `_latest` caller explicitly supplies TTL. Per-intent operations use that immutable binding even if revoked for new entries. Open cost aggregation takes the minimum across all non-CLOSED/non-NO_FILL intents; settlement's cumulative native proof takes the minimum across all account intents including historical CLOSED/NO_FILL. Unused/wider aliases cannot relax existing constraints. Cutoff is exclusive (age==TTL is stale). No schema, old Q03 or public API changes. See astarter-simulation-main-review-A1-A2.md for exact RED→GREEN and new finite native fault evidence.
