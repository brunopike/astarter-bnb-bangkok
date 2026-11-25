# Data / Model Ports v1 — local simulation slice

Owner: 01a16865-c206-74a1-a0a5-c5aaa6f71081. Backend receipt: 2026-10-24, fixed baseline `651ca3b9622dd1f63c340fc5b26f06a4b1815b5e`.

## Scope and ownership

Only new `services/engine/src/stark_trading_os/integrations/`, matching unit tests/fixtures and `data-model-ports-*` documents. Backend owns Control/routes/OpenAPI/persistence/scheduler/merge; strategy thread owns Astarter risk calculations. No existing execution or agent-review contract changes.

Implement a substitutable `DataProvider.fetch_snapshot` and `ModelPort.generate_structured`, immutable outputs, explicit source purpose and identity, freshness, bounded async transport and fixed error codes. Default transport is absent: no environment reads or network. Injected fixture transport is the only transport shipped here. No dependency changes.

### Data

Binance Spot single-symbol 24h ticker: exact price/volume strings, base/quote units and source window. `closeTime` is the statistics window end, NOT last-trade time or executable price freshness. `available_at` is conservative local receipt; source publication time is unknown. Dual-age check is source-window age plus local receipt age. Future/inverted times and symbol/venue/market mismatch fail closed. Snapshot is research-only, not order-book or executable quote. Unknown fields remain unknown. Repeat polling of identical bytes has the same content hash; no ingestion ledger or duplicate events are created.

### Model

OpenRouter non-streaming structured JSON, caller-supplied model/profile and role (A01–A18). Read-only research result (OBSERVE/WAIT/REVIEW), bounded text and evidence IDs validated against input. No model tools, commands or trading authority. Fixed JSON schema and provider.require_parameters; no fallback or blind retry. Timeout and 429 carry safe status/retry metadata. Usage preserves provider-reported input/output/cached/reasoning/cost independently; absent is unknown. Invalid/nonfinite usage cannot become a trusted result. Fixture usage is labeled simulation, never billed cost.

## Acceptance

Default zero network; synthetic fixture success; exact decimals/identity and immutable output; missing/malformed/duplicate keys; stale source or receipt/future time; HTTP error and Retry-After; timeout/cancellation with one attempt; model non-JSON/truncated/refusal/tool calls/bad references/wrong model; usage absent/nonfinite/cached/reasoning; credential not in repr/errors/fixtures; no changes to backend-owned paths. Run targeted pytest, strict mypy/Ruff, adjacent agent/domain regression. Backend independently reviews commit before integration. DP03/04/11 parent tasks remain incomplete.

## Sources (protocol checked 2026-10-24; no authenticated calls)

- https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
- https://openrouter.ai/docs/guides/features/structured-outputs
- https://openrouter.ai/docs/cookbook/administration/usage-accounting
- https://openrouter.ai/docs/api_reference/errors-and-debugging

Data is authored synthetic QA, not downloaded market/account data. No live latency, rate capacity, strategy quality or profitability claim.

## Review repair contract (2026-10-25)

Known configured credentials are checked across decoded task values/model ID and the final serialized result values, including repr-hidden fields. Sensitive input raises fixed `SensitiveInputRejected` before transport and result identity echo; a credential-bearing response becomes INVALID_RESPONSE without output/provider metadata, retaining only safe usage. Decimal construction failures become fixed parse rejection. ModelResult enforces role, status/output, purpose/attempt and chronological consistency. Completion is initial wall time plus monotonic elapsed time; detected wall-clock regression rejects the result without dropping reported usage. This is not a general DLP service or a new model/network authorization.
