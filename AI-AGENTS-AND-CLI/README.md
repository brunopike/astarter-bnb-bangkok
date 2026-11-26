# How Astarter agents make a decision

Ask an agent why it stayed in cash. Its answer can name the market, the evidence it had at the time, the rule that failed and the exposure the trader avoided.

Astarter defines **18 Team agents** to investigate a decision and **18 Strategy agents** to describe the conditions under which a trade makes sense. These are research roles and versioned strategy definitions. The Deep Brain paper engine has its own explicit candidate set of trend, breakout, pullback and cash. [All 36 agents and their responsibilities](36-AGENT-ROSTER.md) · [Paper selection rules](../src/deep-brain/brain-strategy-witness.mjs)

## What one agent can pass to the next

| Layer | What the next agent can check |
| --- | --- |
| **Brain** | The instrument, venue, observation time and decision cutoff identify what the agent knew. For an asset, recall can return up to three relevant records from the preceding seven UTC days. A receipt learned after the cutoff is available for later review. [Recall implementation](../src/deep-brain/brain-agent-recall.mjs) |
| **Thinking** | The agent can inspect each candidate’s signal, sample count and score after costs and a downside penalty. The winner comes with a runner-up, entry conditions and a risk cap. A sensitivity check shows whether omitting a calibration day changes the choice. [Decision witness](../src/deep-brain/brain-strategy-witness.mjs) |
| **Execution** | The brief distinguishes permission, dispatch and settlement. A paper instruction carries a maximum notional. The agent gets fills, costs and net P&L after the receipt passes reconciliation. Pending receipts leave the result open. [Agent brief](../src/deep-brain/brain-agent-brief.mjs) · [Execution checks](../src/deep-brain/brain-execution-invariants.mjs) |

**ChatAndBuild’s Living Brain** supplies persistent memory. The application can capture a wallet-scoped plan and decision under versioned references, then retrieve rules and lessons for a later agent. The paper connector can also upload a receipt, fetch it by source ID and compare its content hash before giving it to a model. The Agents Memory screen labels reconstructed historical assignments and shows which records actually contain personal or shared evidence. [Plan capture and retrieval](../src/astarter-frontend/living-brain.mjs) · [Receipt connector](../src/deep-brain/paper-replay/connections.mjs) · [Memory view](../src/astarter-frontend/brain-memory.mjs)

## Give a local agent the same public evidence

Run these from the repository root with Node.js 20 or later. Each read returns JSON. The quote and the decision identify their own instrument and source. Here the first is an Atlas tokenized-equity quote and the second is a Bitcoin spot paper decision.

```sh
node src/astarter-cli/astarter.mjs doctor
node src/astarter-cli/astarter.mjs markets NVDAB
node src/astarter-cli/astarter.mjs research
node src/astarter-cli/astarter.mjs research coin:bitcoin
```

`doctor` (also `status`) checks the server’s read-only tool contract. `markets` accepts an optional symbol. `research` lists available asset keys. Passing a key returns the brief with its cutoff, decision ID, lifecycle status and evidence links. `connect` prints the Binance Agentic Wallet setup URL for BNB Smart Chain, chain ID 56. Address verification and wallet authorization take place in the browser. [Astarter CLI source](../src/astarter-cli/astarter.mjs) · [Binance Agent OS](https://www.binance.com/en-ZA/agent-os)

## What the model does

- **Answer a trader.** The DApp assistant routes conversation and supplied Astarter context through a server-side model adapter. The adapter validates the dialogue, bounds response length and handles incomplete answers. [Chat route](../src/astarter-frontend/api/assistant-chat.mjs) · [OpenAI adapter](../src/astarter-frontend/assistant-openai.mjs)
- **Review a sealed run.** The backend’s OpenAI Agents SDK reviewer can read an artifact, read an event or compute an allowed ratio. It returns IDs from the supplied evidence. The server rebuilds the evidence scope, validates the IDs and recomputes the ratios before rendering the review. [Agent tools](../src/astarter-backend/services/engine/src/stark_trading_os/agent/openai_review.py) · [Independent validation](../src/astarter-backend/services/engine/src/stark_trading_os/agent/post_validate.py)
- **Explain a paper result.** An optional model call receives a stored receipt and is asked to account for the strategy, position cap, fills, fees and slippage. The response includes the receipt ID, model and SHA-256 of its input. The accounting remains reproducible from the receipt. [Explanation connector](../src/deep-brain/paper-replay/connections.mjs)

To check the paper evidence locally with Node.js 24 or later, use the separate Deep Brain CLI. These commands use the bundled data and a fresh local store.

```sh
cd src/deep-brain
STORE="$(mktemp -d)"
node paper-replay/cli.mjs demo --store "$STORE"
node paper-replay/verify.mjs
```

Use the emitted `memoryId` with `recall ID --store "$STORE"` on the same CLI. `sync ID` writes to your configured Living Brain workspace. `explain ID` calls your configured OpenAI model and incurs provider usage. Add `--remote` to sync and verify the remote content before explanation. Pass the same `--store "$STORE"` to each command. [CLI implementation](../src/deep-brain/paper-replay/cli.mjs) · [Configuration and commands](../src/deep-brain/README.md)
