# Deep Brain decision evidence

Open **Decision proof** on Deep Brain and select a market. The server returns the instruction registered for the next UTC session, its evidence, the alternatives considered, its risk limit, the delivery to paper execution, and the receipt when one exists. The review works before the target market opens. Historical performance appears in the separate replay.

## Reading a decision with an agent

Open **Ask AI** on a decision to draft a question about that instrument and UTC session. The assistant reads the same compact record available at `GET /api/brain/proof?brief=1&asset=coin:bitcoin&date=YYYY-MM-DD`. Integrators can retrieve the read-only tool description and input schema at `GET /api/brain/proof?tool=1`. The asset catalog at `GET /api/brain/proof` lists supported instruments. Omitting the date requests the next UTC session.

The brief binds the frozen source, candidate ranking, risk limit, dispatch and any verified settlement to the decision ID. It reports the later venue recheck separately. Verified receipts and benchmark results carry their post-session timestamp. Missing evidence leaves the corresponding fields null.

Recall examines the seven preceding UTC sessions for that asset and returns up to three records, with coverage and provenance. It only uses events recorded strictly before the target decision was registered, or before the refusal for a rejected registration. The market, quote and strategy fields show how a prior case relates to the current one. Late receipts can be used in a subsequent review after they become known.

On request the independent verifier removes each of the sixty calibration sessions in turn, holds the current signals fixed and reruns the original selection rule. The returned counts show how often the original choice survives, which alternative wins and an example omission that changes the choice. These counts describe dependence on that particular sample. The original dispatch and risk limits remain authoritative.

## What a decision proves

| Layer | Question an observer can check | Consequence |
| --- | --- | --- |
| Brain | Did completed candles belong to this instrument, cover the required window without gaps, and exist in the frozen archive by registration time? | Invalid, late or stale inputs prevent an admissible instruction. An observer can download the archive and reproduce its fingerprint. |
| Thinking | Which candidates met the signal, sample and after-cost score rules? Did the frozen choice win among the eligible candidates, including cash? What position does the versioned risk policy allow? | The choice, all rejection reasons, the maximum quote amount and the stop are fixed before the target open. Cash and risk vetoes allow zero spend. |
| Execution | Did the paper worker receive that exact decision before the open, with the correct instrument, route and amount? Did the later receipt obey it? | A second immutable record binds the instruction to the original snapshot and decision. Settlement checks both records, may reduce or skip the modeled fill, and may never increase the spending limit. Without a valid pre-open handoff it cannot publish a verified receipt. |

When a collection attempt fails its evidence checks, the worker keeps the instrument, attempted session, source cutoff, reason and archive digest. The current view can display that refusal immediately. Fresh evidence can still qualify before the deadline.

A verified decision establishes compliance with a stated strategy set, scoring rule and risk budget. The evidence does not establish that these rules capture every market driver or maximize future returns. The rule set currently admits three long-only spot strategies and cash. Each paper experiment has its own capital allocation. A real broker receipt or a positive realized customer return requires separate evidence. A server timestamp and content digest let observers retain and compare the published record. They do not provide trusted third-party timestamping.

## Evidence and timing

The collector normalizes completed spot candles to UTC open time, open, high, low, close and base volume. The engine verifies the venue and instrument, ordering, continuity, positive volume, price bounds and closure against the archive time. Source specifications: [Binance Spot klines](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints) and [Coinbase Exchange candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles). A source revision creates another archive. Published decisions retain access to their original evidence.

The engine compares trend, breakout and pullback signals with staying in cash. It scores candidates on a rolling preceding sample after modeled costs, with a downside penalty and a minimum qualifying sample. The report contains the signal, score, sample count and rejection reason for every candidate. The next session leaves time for registration. The execution model checks opening conditions before applying the order, stop and session exit rules. Decisions and receipts have distinct content hashes. Results state the fee, adverse slippage and model version. Daily OHLCV cannot establish the exact intraday fill, order-book depth or market impact. These rules implement a deterministic, long-only spot research model.

## Independent verification before and after execution

New registrations bind a second fetch of all 91 completed candles from the designated public venue. The observation pins the original archive bytes, upstream response bytes, instrument, UTC window and completion time. The worker requires an exact match of the quoted OHLCV values for the whole window before it can register a choice. Retries leave their own immutable observations. A later review of a legacy session is identified separately. If a new review detects a conflict before the session opens, the worker records a veto on the existing instruction, even when the decision has already been handed off. A cancelled instruction cannot produce a fill.

A second implementation calculates the signals, all 60 calibration sessions, costs, risk penalty, eligible winner and risk profiles from the frozen window. A separate execution checker verifies the allowable paper route and reconstructs the opening-gap veto, stop or closing exit, quantity, fees, slippage and final balance. The settlement worker also requires an independently observed matching venue candle for the target date. Pending or unverified results cannot enter the performance comparison.

Before the open, the worker can register a comparison plan tied to the decision and its paper instruction. Each independent daily trial compares the selected action to cash and a passive investment of 10% of its initial balance from the same open to the same close, charging fees and adverse slippage on both trades. The passive position deliberately has no strategy stop. The settlement binds the plan hash. Missing, blocked and unfinished sessions remain visible in the calendar. They have no return assigned. This measures the combined choice and risk policy against two named alternatives. The balances are separate experiments and must not be compounded as an account history.

## Two independently inspectable records

- **Historical replay** reconstructs a sequence using closed bars. Code, parameters and source data together reproduce a run. Follow each source link to inspect its UTC window. The ledger includes losses and every skipped session. A positive return, beating cash, and beating the market answer different questions. A low-exposure strategy can outperform full buy-and-hold in a falling market while losing money. Cross-market counts use a common calendar and disclose excluded markets. Market rows are independent experiments, not a funded multi-asset portfolio.
- **Forward paper record** freezes each eligible market's choice and risk on the server before its target UTC open. Each daily experiment starts with an independent simulated balance in its quote currency. A result becomes available after the target day's candle closes. Missing evidence leaves a record pending. A corrected input or a rerun cannot replace the first publication for that market and date. The stored server time and content hashes support external observation and later reproduction. An independent observer can retain the published hash before the open. No wallet or exchange order is involved.

## Reproduce a result

From the repository root on Node 24, run `node scripts/verify-brain-proof.mjs` to reproduce the bundled 90-day cohort. Use the public API to reproduce the result displayed for a newer data vintage.

| Request | Result |
| --- | --- |
| `GET /api/brain/proof` | Supported assets and windows |
| `GET /api/brain/proof?outcomes=1&asset=coin:bitcoin&days=30` | Verified prospective outcomes against both predeclared controls, with the full calendar denominator |
| `GET /api/brain/proof?observation=ID&asset=coin:bitcoin&part=observation` | Byte-exact source check. The response and archive parts return the original bytes for permitted public observations. |
| `GET /api/brain/proof?current=1&asset=coin:bitcoin` | Current decision, operational checks and execution handoff |
| `GET /api/brain/proof?current=1&asset=coin:bitcoin&date=YYYY-MM-DD` | Re-examine a particular UTC target session |
| `GET /api/brain/proof?cohort=1&days=90` | Common-window market comparisons and exclusions |
| `GET /api/brain/proof?asset=coin:bitcoin&days=90` | Run ID, source archive, aggregate metrics and decision index |
| `GET /api/brain/proof?run=RUN_ID&decision=DECISION_ID&evidence=1` | Frozen candles for one decision |
| `GET /api/brain/proof?run=RUN_ID&report=1` | Full historical run |
| `GET /api/brain/proof?forward=1&asset=coin:bitcoin&date=YYYY-MM-DD&evidence=1` | Frozen forward record for the target UTC date, original archive and receipt when available |

Save the last response to a JSON file and run `node scripts/verify-brain-proof.mjs file.json`. Verification rebuilds the decision from the frozen archive, checks the registration precedes the target open, and recomputes any settled receipt from its recorded bar. A receipt with status `skipped` carries its reason and zero simulated trade costs.

## Collection and reconciliation

Run `node scripts/brain-proof-forward.mjs --refresh` periodically after UTC midnight to update completed candles, reconcile prior forward records, and pre-register the next UTC session. Repeated jobs are safe. The mode without `--refresh` uses the saved archive. By default forward records and the private working candle archive live under `~/.local/share/astarter/deep-brain/forward`. The read-only API serves that archive when present and falls back to the bundled archive on a fresh installation. Immutable replay reports are written under `~/.local/share/astarter/deep-brain/proof-replays`. Neither directory belongs in a public static file tree.

## Run locally

[Collect data, verify a paper decision, or read a saved memory](../paper-replay/README.md).
