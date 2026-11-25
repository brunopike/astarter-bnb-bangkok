# Local public-data collector (bounded read side)

This is an explicitly started, single-local-owner public collector, not a daemon,
trading connection, Control service, historical warehouse, or quota entitlement.
The frontend is unchanged. Live/API/frontend acceptance belongs to Codex.

## Start / stop

Use the existing project Python **3.12** environment. From the repository root,
set `PY` to that interpreter and `DB` to an **absolute, dedicated new public SQLite
path** whose parent already exists. Never use a Control, ledger, or existing QA DB.
No dotenv file is loaded. Import and `--help` open no database/network/worker.

```sh
PYTHONPATH=services/engine/src PYTHONDONTWRITEBYTECODE=1 "$PY" \
  -m stark_trading_os.control.public_data_runtime --help

PYTHONPATH=services/engine/src PYTHONDONTWRITEBYTECODE=1 "$PY" \
  -m stark_trading_os.control.public_data_runtime \
  --enable-external --db "$DB" --duration-seconds 90 \
  --binance-daily-cap 6 --coingecko-daily-cap 1 --blockbeats-daily-cap 2 \
  --dig-resolver
```

The sample caps are a small **operator-chosen reservation budget**, NOT verified
vendor plan limits, prices, or daily product defaults. All three finite caps are
mandatory; zero disables that provider's admission. Caps are per UTC day, not per
invocation: restarting cannot restore spent quota. A run spanning UTC midnight
can use the new day's cap too. Do not use a new DB to evade an existing budget.
`--duration-seconds` is mandatory: choose an explicit finite positive integer from
1 through 253402300799 seconds. This numeric safety ceiling is the supported public
timestamp range converted from milliseconds to whole seconds, not a 24-hour session
limit. It prevents oversized integers from overflowing the asyncio timer; invalid
durations are rejected before application/resource/network startup. There is no
default or infinite runtime. After lifespan startup, the timer bounds requested
serving time, not synchronous disk latency or OS cleanup latency; no end-to-end SLA
or ability to operate beyond the supported timestamp range is claimed.

Binding is fixed to `127.0.0.1:8765`, exactly one worker, with the existing exact
Origin policy for `http://127.0.0.1:4188`. No alternate hosts, ports, forwarded
identity, mutation routes, model calls or Control dependency factory are enabled.
`--dig-resolver` explicitly selects the existing `PublicDigResolver`; omit it for
the transport's existing system resolver. Neither resolver bypasses IP allowlists.
No DNS prewarm occurs: the budget reservation precedes even the first DNS call.

Stop with Ctrl-C / `kill -TERM <pid>`, or let the duration expire. The outer runtime
owns SIGINT/SIGTERM through cleanup, including server startup/bind failures. It
installs no scheduler/launchd service and does not survive session shutdown.
Repeated signals do not detach cleanup. A forced process kill releases the OS
lease but may leave a conservatively unresolved charged reservation (below).

Credentials are injected programmatically using `PublicDataCredentials`, or read
internally from only `COINGECKO_API_KEY`, `COINGECKO_TIER` (`pro` default / `demo`),
and `BLOCKBEATS_API_KEY` at explicit startup. Never paste keys into CLI arguments,
logs, status commands, reports or this document. Missing asset/news credentials
produce genuine `UNCONFIGURED` observations, not fabricated data. An admitted but
unconfigured batch is still charged conservatively even if it makes zero HTTP calls.

## Read / status

The four existing GET contracts are unchanged:

- `/v1/data/markets` — canonical BTC/ETH/SOL batch; asset filters are projections.
- `/v1/data/assets` — one canonical three-asset batch.
- `/v1/data/news` — one canonical news50 feed; limit20/50 share it.
- `/v1/data/explorer/capabilities` — **local registry**, never chain polling.

```sh
curl --fail -H 'Origin: http://127.0.0.1:4188' \
  'http://127.0.0.1:8765/v1/data/news?limit=20&selection_version=1'

sqlite3 -readonly "$DB.collector-policy.sqlite3" \
  'SELECT scope,mode,daily_cap,interval_ms,weight,day,reserved_weight,next_at_ms,pending FROM collector_budget;'
```

GET/Refresh/filter changes never dispatch or join an upstream request. Every read
loads the shared persisted snapshot; cold cache is a 200 truthful unavailable
envelope, and store failure is the existing sanitized 503. Expiry only changes
quality, never source event/received/available/as-of timestamps or revisions.
Successful empty news remains distinguishable from never available news. Registry
freshness describes registry observation, not verified on-chain facts.

### Binance market history is display continuity, not a new quote

For canonical Bitcoin/Ethereum/Solana Binance SPOT/USDT statistics only, a failed
or missing asset can retain its last legal observation while other assets update.
The service snapshots immutable history before the upstream await, validates the
incoming payload, and checks full subject/provider/venue/instrument identity before
reuse. Duplicate or mismatched observations are not made valid by fallback. The
strict adapter, PUBLIC item chronology, transport guards and trading contracts are
unchanged: a future statistics-window `closeTime` is still rejected. Receipt time
is never clamped, delayed or re-sampled to accept it. These are 24-hour statistics,
not executable prices or trade-event timestamps.

- Reused rows are **stale immediately**, even before their original expiry. Only
  row quality changes: record/revision, event/receipt/availability/expiry, window
  times, identities and exact Decimal strings remain unchanged. Expired history
  can remain visible; no new retention TTL or renewed validity is implied.
- `coverage.returned_subjects` equals the subjects actually displayed, including
  historical rows. `coverage.gaps` reports the **current collection** failures or
  missing assets. Their intersection is permitted only for stale history. Three
  displayed rows therefore do **not** mean three currently fresh observations.
- Mixed current/fresh and historical/stale rows are `partial`; all stale history
  is `stale`; no legal current or historical rows is `unavailable`. Ordinary
  expiry can further decay quality. Batch `as_of_ms` is the newest displayed
  `available_at_ms`, not proof that every row updated at that time.
- Asset filters preserve selected collection gaps even when history is displayed.
  A BTC-only response can be stale with a bitcoin gap; a successful ETH-only
  response has no bitcoin gap. A new legal BTC observation clears its gap, not
  an unrelated asset's successful refresh, GET, save or restart.
- Current source status/reason/Retry-After remains unchanged. Sources have no
  subject identity, and all three Binance reads share a provider ID; the service
  does not attribute another asset's success or last-success time to historical
  BTC. A whole-fetch exception emits the existing sanitized failure evidence with
  current gaps, never the previous successful coverage claim.
- Current and last-good persist the same merged observation under the unchanged
  store equality invariant and CAS fence. Here last-good means each retained
  row's last legal fact, not the last all-successful batch. Cancellation and
  `before_save`/commit failures cannot publish an uncommitted merge.

Cold or already-lost BTC history cannot be recovered from a body hash. It remains
missing until a genuinely legal observation arrives; fallback cannot guarantee
three prices. The observed +63ms rejection was one instrumented sample, not proof
of all historical failures or which clock was wrong. Offline +63ms/+600000ms tests
are synthetic counterexamples, **not** a replay of the unsaved live response.
The CoinGecko header compatibility below addresses one separately instrumented
rejection; its body parser remains unchanged. Live stability and frontend/mobile
acceptance require separate bounded validation, not these offline checks.

### CoinGecko-only duplicate Strict-Transport-Security compatibility

One current instrumented CoinGecko HTTP 200 response was rejected by the original
strict header validator for two nonidentical `strict-transport-security` fields.
No raw header values or body were retained. This establishes that rejection only,
not the cause of all historical `OTHER` failures. Offline fixtures use invented
values, not a reconstruction of the live response.

Only `COINGECKO_ASSETS` permits this duplicate metadata field at the PUBLIC response
boundary. With multiple STS fields, it retains the **first** field's name, value and
position in original order, then delegates to the unchanged strict validator. It
never comma-joins STS or chooses the last/minimum/maximum directive. Zero or one STS
field takes the original strict path; STS semantics remain opaque.

The narrow compatibility basis is [RFC 6797 section 8.1](https://www.rfc-editor.org/rfc/rfc6797#section-8.1):
a user agent receiving multiple STS fields over secure transport must process only
the first. Section 7.1 requires an emitting HSTS host to include only one STS field.
This backend is not a browser HSTS implementation: it stores/enforces no HSTS state
and forwards no STS or new metadata to clients. This does not relax TLS security.

Before any duplicate removal, all original fields count toward the existing
64-field / 16384-byte post-parser limits, and every original name/value must pass
the original token / visible-ASCII checks, including any later discarded STS field.
These remain post-parser bounds, not HTTPX/h11 allocation limits. Inputs are not
mutated. All other duplicate fields remain rejected, except the existing
`set-cookie` exception and **BlockBeats-only** Vary normalization. CG duplicate Vary
is still rejected. Binance PUBLIC, shared trading/execution and OpenRouter strict
response policies are unchanged.

Forced HTTPS, TLS verification, fixed hosts, IP pinning/SSRF checks, no redirects,
no cookies, framing, content type/encoding/length, Retry-After, stream limits,
timeouts, identity, chronology and credential-echo checks remain unchanged. Offline
proof is not live acceptance or authority to restart a closed failed trial.

Runtime logs use fixed operational codes (`PUBLIC_COLLECTOR_STARTED`,
`PUBLIC_COLLECTOR_FAILED_CLOSED resource=...`, `PUBLIC_COLLECTOR_STOPPED`,
`PUBLIC_COLLECTOR_STOPPED_WITH_ERROR`) and never raw provider exceptions. Embedded
apps can inspect `app.state.public_data_collector.state` and `.failed`; these are
operational status, not an added public HTTP contract. The CLI stops nonzero on
worker failclosed; ordinary upstream errors keep other resources collecting.
HTTP data freshness alone is not proof that the collector is currently running.

## Cadence / failure / cost semantics

| Provider scope | Canonical collection | Minimum cadence | Reserved weight / admission | Actual HTTP maximum |
|---|---|---:|---:|---:|
| Binance public spot | markets BTC/ETH/SOL | 10 s | 3 | 3 (bounded parallel asset reads) |
| CoinGecko assets (selected tier) | assets batch | 300 s | 1 | 1 |
| BlockBeats news | news50 | 60 s | 1 | 1 |
| Local registry | all supported capabilities | 300 s | 0 | 0 |

`--binance-interval-seconds`, `--coingecko-interval-seconds`,
`--blockbeats-interval-seconds`, and `--registry-interval-seconds` may only slow these
minima (bounded to 366 days). Cadence is completion-anchored, not catch-up scheduling.
A slow resource awaits independently from the other workers and from all GETs.
SQLite and validation remain synchronous on the event loop; this is not a capacity
or latency guarantee.

Ordinary timeout/invalid/unavailable/partial-error observations use a **fixed**
retry floor of 60 seconds, or a larger resource/operator interval; there is no
exponential counter. Valid recovery resets the ordinary retry floor to the
configured cadence. Source Retry-After and existing persisted refresh deadlines
always take precedence. Fractional HTTP Retry-After is conservatively rounded UP
to whole seconds in the public transport **after** unchanged strict response
checks, because the existing adapters parse integer seconds / HTTP dates. There
is no new host/header/request allowance. No provider or resolver code was changed.

Counters use `floor(UTC_epoch_ms / 86400000)`. Only the current day gets a fresh
bucket; there are no missed-day credits. Backward wall-clock movement cannot roll
back the stored high-water mark, restore quota, or shorten deadlines; a backwards
clock during completion fails closed. Forward movement can advance the current
UTC day once, not create a burst. Every worker checks an independent monotonic
not-before gate on **every wake**, in addition to the persisted UTC admission gate.
Completion anchors the full cadence / observed retry duration on that elapsed clock;
early/repeated wakes and UTC forward jumps cannot shorten it. Oversleep permits one
new batch, never replay of missed intervals. A backward jump must still satisfy the
persisted UTC gate even after the elapsed gate opens.

New empty history can collect immediately. On every new exclusive session, existing
history (pending OR completed, including snapshot-only legacy history) waits at least
the full conservative duration from startup:

```text
duration = max(configured interval, 60000,
               policy.next_at_ms - policy.last_wall_ms,
               snapshot.refresh_at_ms - snapshot.fetched_at_ms)
known_utc = max(policy.next_at_ms, policy.last_wall_ms, snapshot.refresh_at_ms)
startup_utc_gate = max(known_utc, startup_utc + duration)
startup_monotonic_gate = startup_monotonic + max(0, startup_utc_gate - startup_utc)
```

All values above are milliseconds; absent snapshot terms are zero. Policy duration
is captured from the original row before reconciliation. Snapshot duration is used
even without policy history; the policy duration covers a deadline committed before
the corresponding snapshot. **Both runtime gates** must open before admission, and
normal persisted UTC deadlines/high-water/day budgets are still checked afterward.
Startup guards are never written into the durable policy or snapshot timestamps.

Thus a known `Retry-After: 172800.25` (rounded up to 172801 seconds) requires the full
172801 seconds again even if UTC jumped three days **before** the new owner started.
Every restart can conservatively wait that full duration again: restarts reset the
same duration, never add accumulated downtime to it or refund budget. Completed
markets still wait at least 60 seconds; slower configured intervals still win.
Monotonic time is not persisted across processes/reboots, and previously elapsed
downtime is not trusted as credit. Absolute UTC budgets/deadlines still depend on
the host UTC clock; there is no distributed or vendor-time verification claim.

Repeated short runs may therefore never refresh a lane. Select a finite
`--duration-seconds` longer than the longest expected known startup recovery window,
with time left for a fresh batch. For example, `--duration-seconds 259200` permits
one uninterrupted session to outlast a known 172801-second recovery hold, rather
than restarting that hold every day. Longer configured intervals or future absolute
UTC gates may require a longer run within the numeric safety ceiling above. All
UTC/monotonic gates and daily budgets still apply; a longer duration does not promise
a successful refresh or grant extra quota. Do not reset the DB or shorten known
deadlines to bypass recovery.

The policy stores **reserved HTTP weight**, not measured wire attempts or batch
counts. Reserve/commit happens before any provider/DNS action. There is no refund
for missing credentials, rejected DNS, partial results, timeouts or interrupted
attempts. Enforcement is per scope/mode on this public DB, not per user or filter;
it does not coordinate other DBs, machines or unrelated users of the same vendor
account/IP. Operators must allocate caps conservatively across those consumers.

## Persistence and failure boundaries

Files for canonical absolute `DB`:

1. `DB`: unchanged `AstarterPublicData.v1` / `public-data-projection.v1` public
   snapshot schema, CAS and last-good behavior. No migration or Control schema edits.
2. `DB.collector-policy.sqlite3`: distinct application ID `0x41504350`, user_version
   1, exact two-table STRICT/WITHOUT ROWID schema. One binding row stores canonical
   public path and initialized-mode bits; at most six budget rows are keyed by
   `(provider scope, mode)`. Bounds/NOT NULL/CHECK/unique constraints cover caps,
   weights, windows, deadlines and pending state. Missing initialized budget rows,
   changed schema/version/path or conflicting policy are rejected, never repaired.
3. `DB.collector.lock`: stdlib nonblocking lifetime flock. The file is deliberately
   retained, never truncated/unlinked and never interpreted as a PID. Symlink DB
   aliases resolve to the canonical lock; hardlinked DBs/locks are rejected. Lock
   and DB inode identity are checked before each cycle. This is cooperative local
   ownership, not protection against an administrator replacing files.

Public v1 stays byte/schema compatible because limiter state is a separate concrete
sidecar. Tradeoff: there is no cross-file atomic transaction. Instead:

1. Commit charged weight plus `pending=1` before upstream.
2. Commit the resulting deadline (including Retry-After) while still pending.
3. CAS-save current projection and last-good using their original observation times.
4. Clear pending only after successful snapshot persistence.

An interruption stays **charged**, but does not permanently disable collection.
Only a newly acquired exclusive OS owner can consume a one-use startup session permit
to reconcile all policy rows atomically, before any worker is scheduled. Another
collector sharing a live owner, a policy reader/reopen, elapsed wall time alone or
policy reconfiguration cannot do this. A recovery commit failure rolls back every row,
starts no workers and consumes that session; close it and acquire a new owner.

Recovery clears `pending` without refunding `reserved_weight` or changing its UTC
`day`, `last_wall_ms` or `next_at_ms`. It returns a runtime-only startup guard to the
collector; all original durable deadlines remain exactly unchanged. Waiting on the
startup gates does not update the policy high-water or public metadata. No projection,
last-good, revision, or source/as-of time is rewritten. Each admitted GET batch spends NEW
budget; ordinary UTC-day rollover is still allowed, not an interrupted-charge refund.

| Crash/cancel window | New exclusive session outcome |
|---|---|
| Before reservation commit | No new charge; existing-history restart guard still applies. |
| Charged reservation → deadline commit | Retain charge and provisional deadline; wait known gates + restart floor. |
| Deadline commit → snapshot commit | Retain persisted Retry-After/cache gate and old snapshot/last-good. |
| Snapshot commit → complete | Retain committed snapshot/last-good/source times and all known deadlines. |
| After complete, or after recovery but before next attempt | Existing-history restart guard; no immediate retry or refund. |

Public HTTP GETs are idempotent; this is conservative repeatable collection, **not
exactly-once wire execution**. A response/Retry-After never observed or not durably
recorded before crash cannot be reconstructed or promised. The cautious restart
hold bounds that ambiguity; it cannot honor an unknown vendor deadline. Keep this
operational limit visible rather than permanently blocking all providers.

Do not delete/rename/reset these files, change mode, swap DB paths or lower policy
to recover quota. Snapshots remain readable by a snapshot-only service/store without
the writer lease. Normal close cancelling an in-flight fetch uses the same recovery
path as process crash; store/schema/ownership corruption remains strictly failclosed.

Policies are immutable for a given scope/mode once initialized. A planned policy
change or relocation needs a separately reviewed migration/reconciliation, not
silent mutation by this CLI. No unbounded attempt log is stored. On an empty new
sidecar, schema/identity/policy initialization is atomic; failure rolls back all
DDL and marker changes. Incompatible existing public or policy DBs are rejected
before schema mutation. Tests only create disposable synthetic fixtures/copies.

Ownership is explicit LIFO: stop/join worker tasks → close shared service → close
each transport → resolver → policy connection → public connection → lifetime lease.
The existing owned-cleanup primitive prevents repeated cancellation detaching this
sequence; cleanup failures still run remaining owners and produce a sanitized error.
The outer runner owns the server and app lifespan once (uvicorn lifespan disabled
there only); app factories used normally still run collection only inside their
explicit lifespan. Default/on-demand assembly remains unchanged and does not open
public storage, construct public transports or start collector loops by default.

## R2.1 Binance percentage contract (2026-11-13, offline)

`priceChangePercent` from Binance FULL 24h statistics is passed unchanged through
`SpotTicker.price_change_pct` to `MarketData.price_change_pct`. It is a signed
decimal string in percent units (`"2.500"` means 2.5%), not a return fraction or a
value derived from last price. Absence remains `null` for old snapshots; a present
null, numeric JSON value, non-finite/exponential/malformed string is rejected.
The 80-character limit matches the existing frontend public-envelope consumer.

New readers accept old SpotTicker payloads without this optional field; the public
AstarterPublicData.v1 field already exists. The strict internal SpotTicker producer
and readers must be exported together: old extra-forbid readers cannot read the
new field. This does not claim arbitrary mixed-version internal compatibility.
Original prices, volumes, identity, body hash and clocks are unchanged. Source event
time is `closeTime`; receipt/availability are the original adapter observation time;
expiry is source event + 30 seconds. Batch `as_of_ms` is the maximum availability
time, **not** a replacement source clock. Cached/last-good rows keep every original
value and timestamp and become stale. Future source times remain rejected.

The existing market cadence is a 10-second minimum per service instance, not an
upstream freshness SLA or global quota. Three single-symbol requests cost three
HTTP calls / six Binance IP weight units per batch under the current official
24h endpoint table. No batching, continuous schedule, quota activation, deployment,
existing database change or paid-source configuration is part of this slice.

Official endpoint semantics: https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market
