# R2.2 shared PUBLIC read layer

This opt-in local-qualified assembly reuses the PG2 pool/transaction boundary and the existing PublicDataService. It is not installed into the deployed Vercel reader. No provider, credential, database, scheduler or model is opened on import or app construction.

## State and authority

Use a dedicated PUBLIC database, separate from the frozen private PG2 database. The existing PG2 catalog covers the entire database; adding unrelated schemas there would invalidate it. The new access contract keeps that check unchanged. There are three tables in `public_data`:

| Table | Identity and authority | Lifecycle |
| --- | --- | --- |
| snapshots | resource + mode; PUBLIC v1 projection | Current and last-good payload, original clocks, revision CAS |
| budgets | provider scope + mode | Owner-provisioned immutable cap/expiry/interval, UTC daily and cumulative reserved HTTP counts, next admission, epoch and active request |
| attempts | request UUID + mode; unique scope + mode + epoch | RESERVED → COMPLETED / UNKNOWN / EXPIRED; no deletion, retry or refund |

`public_data_read` can read snapshots only. `public_data_collect` can read public tables and write only operational columns; no DDL, DELETE, cap change or private strategy-table access. App LOGIN roles each inherit exactly one corresponding plain NOLOGIN capability without admin option. Every transaction revalidates roles, effective privileges (including schema grant options) and the independent pristine catalog pin for the PUBLIC schema ACL. This is trusted-backend/cooperative-owner drift detection, not hostile-DBA attestation or client credential distribution.

LOCAL_PG17 remains the default. PUBLIC NEON_PG17_V1 uses separate fixed empty/full catalog pins captured from a pristine dedicated Neon oracle, independently reproduced locally; it does not reuse the private PG2 full pin or learn from an application target. Neon pools require explicit sslmode=verify-full and channel_binding=require before construction, then actual client TLS and PG17 are checked on each transaction. Database TEMP and database grant options are refused, including on reused connections. A new PUBLIC installation revokes default TEMP only on its own database. Existing installations are not automatically rewritten. Owner installation and seed are explicit, atomic functions (`install_public`, `seed_public`); neither reads SQLite paths or discovers a target. Existing populated PUBLIC SQLite fixtures can be imported through the existing validated StoredPublicData and PolicySnapshot records. Revisions, prices, source clocks, charged reservations and known deadlines survive; unresolved work gains a full recovery hold. Re-seeding an initialized mode is refused, never a quota reset. If SQLite lacks earlier-day cumulative usage, the operator must deduct it from the total cap before seed; the importer cannot invent that measurement.

## Critical path

1. An explicit shared app lifespan opens separate reader/collector pools. Ordinary GET uses the existing four routes/DTOs and snapshot-only mode. Cold or missing snapshots honestly return unavailable; failures do not fall back to stale process RAM.
2. The optional POST `/internal/public-data/refresh` requires a server-only bearer token of 32–256 ASCII characters, a single Authorization header, no Origin or query, and a <=1 KiB body received within 3 seconds. Body: `{ "request_id": "UUID", "scope": "binance|coingecko|blockbeats" }`. Public app assembly has no collector by default.
3. Coordination and cache-expiry decisions use the current database clock injected into the existing service; worker clock offsets cannot shorten RetryAfter or reject an already-due snapshot. Provider event/received/available/expiry timestamps remain untouched. Under the existing DAL transaction/advisory lock, the shared budget row is locked, current request/result reconciled, and cap, expiry, hold, snapshot deadline and active lease checked. Reservation is committed before the owned provider factory is entered. Binance reserves three HTTP calls; CG/BB reserve one. These are conservative admission units, not measured wire counts or Binance IP request-weight units.
4. One canonical query is fetched outside the transaction. Existing provider timeout is 6 seconds, orchestration uses a 12-second async deadline, native pool/statement/lock waits remain bounded. The HTTP assembly offloads whole owned calls to at most four worker threads per instance, with a 3-second admission wait, so synchronous DAL waits cannot block the HTTP event loop. Disconnected callers cannot cancel/abandon in-flight DB threads; app shutdown drains admitted calls before closing pools. These limits assume the existing cooperative bounded transports; arbitrary cancellation-resistant callbacks are unsupported, and synchronous DAL waits are not a 12-second wall-time SLA. There is no continuous loop or automatic retry.
5. Observed RetryAfter is persisted before saving. Snapshot and terminal receipt commit together under the current request/owner/epoch/lease fence. Completion is a durable processing result, not a claim of fresh provider data. Failed observations can complete with stale/unavailable data. GET keeps original timestamps and does not manufacture freshness.
6. Cancellation/unknown IO remains charged. Unknown COMMIT is not replayed; resubmitting the same request UUID reads the existing durable result without a second provider call. Lost owner leases expire without refunds; a later distinct request can proceed only after all shared holds/caps permit it. A stale owner cannot save.

Explorer capabilities are local registration metadata, not a fourth paid provider scope. Their snapshot can be explicitly owner-seeded; no arbitrary upstream endpoint is accepted by refresh. Platform trigger cadence, token management, deployed CORS and cloud connection limits belong to the later deployment gate; this package does not assume persistent Vercel workers or 10-second Cron.

## Verification and rollback boundary

Only the already installed PG17 Unix-socket runner and new synthetic databases are used. Tests cover two pools/instances, actual application LOGIN permissions, populated SQLite import/rollback, cap/retry/lease races, both acknowledged and ambiguous commits, snapshot-only four GETs, auth/replay/cancel/timeouts/cleanup and the existing PUBLIC/PG2 regressions. No real market API, model, account, current DB, Neon or cloud long test is required or enabled.

Run from `services/engine` with `PYTHONPATH=src` (the environment also contains an older installed copy), `PYTHONDONTWRITEBYTECODE=1`, `pytest -p no:cacheprovider`. Local PG tests additionally require the explicit owned `PG2_TEST_ROOT`/`PG2_TEST_SOCKET` marker supplied by the existing finite test runner. There is no DSN discovery. Evidence and the exact runner are in the current task's `r2-2-20261113` directory.

No production switch occurred, so rollback is simply retaining the current deployed reader. A future cutover requires qualified cloud roles/catalog, verified current vendor entitlement (BlockBeats pending), a working bounded refresh source, and separate deployment authorization. No private database migration is part of this package. Q08 and S03 remain paused.

## R2.3 existing provider assembly

`create_shared_public_app(..., providers=SharedPublicProviders(...))` is the opt-in adapter wiring. It uses the same `PublicDataProvider`, `provider_fetcher`, strict fixed-destination transport and R2.2 DAL. It is mutually exclusive with the original raw `fetcher_factory` test/embedding hook and requires a collector pool. The read-only app needs neither configuration nor a key. No default application or deployment is changed.

Server configuration is explicit and immutable; no `.env`, credentials file, database URL or upstream URL is discovered. Supply keys through the existing `PublicDataCredentials` argument from the separately authorized server secret loader. Both credentials and injected transport factories are excluded from repr. Never put either key or refresh bearer in URLs, public JSON, browser configuration or diagnostics.

| Setting | Behavior |
| --- | --- |
| `mode` | Must equal the shared store mode; fixture and external transport purposes cannot mix |
| `enabled_scopes` | Exact tuple of `binance`, `coingecko`, `blockbeats`; empty by default; unknown/duplicate values refused |
| `credentials` | Existing typed credentials; CG uses explicit `pro`/`demo` tier, BB `api-key`; missing key disables that paid scope |
| `enable_external` | False by default; external-mode scopes remain disabled until explicitly True; not a vendor-entitlement assertion |
| `transport_factory` | Optional owned context for synthetic/offline tests; purpose must match mode; without it only explicitly enabled external mode can construct the existing strict transport |
| Shared DB policies | Still authoritative daily/cumulative reservation units, cadence, expiry, unknown charges and RetryAfter; no config cap override or reseed |

For this delivery BlockBeats is omitted from real `enabled_scopes` until current entitlement is verified. No real configuration/secret was loaded or enabled. In an offline test, use mode `offline_fixture`, synthetic credentials and a fixture transport factory. Its `send` count is an observed fixture count, not vendor billing or measured external wire attempts.

After authenticated request validation, disabled/missing-key scopes return `UNCONFIGURED` for new UUIDs before a reservation, transport construction or send. An existing UUID still reads its durable receipt (including unresolved RESERVED/UNKNOWN); a conflicting scope is refused. This lookup is read-only, never a rearm or refund. A configured request is still denied by the global cap/expiry/hold/fence if ineligible. Only an admitted request creates the single selected transport. One CG request obtains BTC/ETH/SOL; one BB request obtains the canonical 50-item feed. The existing asset selectors/news20/news50 project that same stored collection; keyword filtering remains client-side on those items, not an extra provider call. No generic URL, per-user collection, scheduler, new SQL table or second retry loop is introduced.

A failed provider observation retains the existing last-good projection, original `as_of`, source/receipt/expiry and latest failure status; rows become stale. Cold failure has no data and is unavailable. Legitimate partial CG data reports gaps without inventing a row; a successful empty news feed is distinguishable from unavailable. Disabled or cap-exhausted refresh does not erase the shared snapshot or falsely renew it: existing records age at their original expiry. There is no claim of current freshness solely from a COMPLETED receipt. Cleanup uses the existing owned-cancellation primitive.

The current response compatibility rules are unchanged (CG's documented first STS field and BB's narrow Vary handling already exist); unknown duplicate headers, framing, source clocks, body limits and invalid identities remain rejected. This package does not claim to diagnose or repair a newly observed real CG anomaly.

R2.3 acceptance is local-only under the current user instruction: real adapters and HTTP handlers with synthetic transport plus isolated native PG. Real source acceptance, deployed safe secrets, qualified PUBLIC cloud profile, finite trigger cadence and F2 browser cutover remain R2.4 activation gates. No present database, cloud account or paid API was accessed.


## R2.4-DB isolated Neon qualification

The dedicated PUBLIC oracle/test databases are in the existing synthetic Neon project and child; the private PG2 database is unchanged. Runtime roles inherit exactly one PUBLIC capability and no owner/admin rights. The provider mode used by cloud checks is **offline_fixture**, and all data is synthetic. A cloud storage connection does not enable suppliers, model calls, schedules, current-database migration or production deployment.

The finite application check reuses this DAL, pool and shared ASGI app. Its explicit pool acquisition allowance is 10 seconds for the sandbox cold start; it does not change the production default or establish a latency SLA. Local tests cover profile mismatch, schema drift, database privilege drift, actual no-TLS rejection, concurrent budgets, unknown/cancel recovery, and shared snapshot behavior. Cloud evidence and the exact reviewed candidate are recorded in the project task `r2-4-db-20261114`; qualification is only complete when both independent reviews and the finite cloud receipt pass.
