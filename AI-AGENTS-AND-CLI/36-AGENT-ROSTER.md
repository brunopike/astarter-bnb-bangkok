# 18 Team agents and 18 Strategy agents

The Team agent’s ID identifies who owns a research question. The Strategy agent’s ID identifies the rules for a particular opportunity or risk. Both give another agent a precise reference to revisit when evidence changes.

## Team agents

The role registry covers four stages of work. A handoff can identify the original observation, what the reviewer concluded and which question remains open. [Role registry](../src/astarter-frontend/simulation.mjs) · [Working memory and evidence mappings](../src/astarter-frontend/brain-memory.mjs)

| ID | Team agent | Research responsibility |
| --- | --- | --- |
| A01 | Market context | Identify the venue, time window and evidence coverage. |
| A02 | Multi-timeframe trend | Align closing times and flag disagreements across intervals. |
| A03 | Price action | Locate breakouts and record the price that invalidates them. |
| A04 | Price & volume | Check whether turnover confirms the move and where it occurred. |
| A05 | Order book & liquidity | Inspect depth, spread and the age of executable quotes. |
| A06 | Volatility & anomalies | Locate abrupt moves and check whether other venues share them. |
| A07 | Strategy rules | Match each trigger to a source, threshold and expiry. |
| A08 | Long thesis | Document evidence for entry and what would invalidate it. |
| A09 | Exit thesis | Review evidence, available depth and costs for an exit. |
| A10 | Counter-evidence | Trace contradictions and identify reports repeating one source. |
| A11 | Wait & budget | Record missing confirmation and when to reassess. |
| A12 | Scenario analysis | Define the triggers for continuation, reversal and invalidation. |
| A13 | Decision synthesis | Reconcile findings and carry unresolved objections into the decision. |
| A14 | Portfolio exposure | Check concentration and overlapping risks across positions. |
| A15 | Capital protection | Review downside, exit liquidity and remaining exposures. |
| A16 | Execution quality | Match orders and receipts to quotes, fees and slippage. |
| A17 | Execution diagnostics | Locate delays and gaps in collection, dispatch or execution. |
| A18 | Attribution & review | Keep the original thesis, later prices and receipts available for review. |

## Strategy agents

Each catalog entry specifies its market, setup, entry, exit, risk and validation requirements. Some depend on data such as finalized pool activity or versioned exchange-flow labels. Inspect the entry’s requirements and execution status before using a rule. [Strategy catalog](../src/astarter-frontend/strategy-catalog.mjs)

| ID | Strategy agent | What its rule checks |
| --- | --- | --- |
| S00 | Multi-timeframe alignment | Align trend and structure across intervals before a breakout. |
| S01 | Range grid | Freeze the trading range and cap inventory across four buy levels. |
| S02 | Bounded scaling | Limit a mean-reversion basket to three tranches and a common stop. |
| S03 | Trend following · MA & RSI | Require an EMA uptrend, a fresh RSI crossing and an acceptable volatility band. |
| S04 | Structure breakout | Confirm a price range, an upside break and a retest above that range. |
| S05 | Order-book scalping | Check synchronized trades, fresh depth, imbalance and an edge after costs. |
| S06 | Wave continuation | Wait for a confirmed five-pivot sequence and a volume-backed breakout. |
| S07 | Price & volume confirmation | Detect a break below support, recovery and a lower-volume retest. |
| S08 | Inside-bar breakout | Require an inside bar in a rising structure and a confirmed break above it. |
| S09-A | On-chain spreads | Price an atomic round trip across two pools at the same chain state after costs. |
| S09-L | Liquidity management | Check pool ticks, inventory requirements and the risk of a concentrated liquidity position. |
| RX01 | Macro event follow-through | Use the actual publication time and wait for a post-release breakout. |
| RX02-P | Narrative momentum | Deduplicate original posts and require independent attention plus price confirmation. |
| RX02-A | Social attention shifts | Compare aggregated mentions and interactions with their own historical baselines. |
| RX03-S | On-chain trade flow | Compare finalized buy and sell flow at a named pool and check spot confirmation. |
| RX03-B | Exchange flow changes | Test abnormal BTC exchange outflows using labels available at the time. |
| RX04 | Unlock-event protection | Restrict new buying around qualifying unlocks and evaluate distribution pressure. |
| RX05 | Post-liquidation recovery | Identify a derivatives deleveraging event, then require a separate spot recovery signal. |

[Return to the agent guide](README.md)
