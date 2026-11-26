# Astarter at BNB Bangkok

**A fresh price can still lead to a stale decision.** When agents hand off a trade idea for a tokenized stock, a price alone is of little use. The next agent needs its timestamp, the market conditions, and the rule that would invalidate the trade. Astarter is an AI Trading OS that gives agents a shared market snapshot and ties each decision to the evidence available at the time.

[Run the local demo](#run-locally) · [Inspect the integrations](#what-you-can-verify) · [Download Hackathon frontend packages](https://github.com/brunopike/astarter-bnb-bangkok/releases/tag/v0.7.0-frontend) · [Download v0.1.0](https://github.com/brunopike/astarter-bnb-bangkok/releases/tag/v0.1.0) · [BNB Bangkok](https://www.hackquest.io/hackathons/BNB-Bangkok)

## Two ways to turn research into a strategy

A sudden move in a BNB Chain tokenized stock is a reason to investigate. In the workflow below, the market agent checks price freshness, venue liquidity, and execution cost. The on-chain agent checks flows and looks for evidence that contradicts the trade. Both work from the same snapshot. If a source is missing or stale, the decision stays on watch and the agents request a new snapshot.

The execution layer uses a verified decision in two ways. A **configured strategy** watches for its trigger and publishes a signal for user review or execution within an existing authorization and risk policy. A **candidate strategy** draws directly on the original snapshot, past cases, and the verified decision. Its public beta and historical backtest use the same strategy and parameter versions. Both paths write outcomes back to the case library so the next agent can see why a rule changed.

### Shared-brain architecture

The diagram shows the target workflow for research, strategy generation, and execution.

[![Astarter’s shared-brain architecture in three horizontal layers. The pinned snapshot directly informs new strategies. Both execution routes return versioned outcomes to shared memory.](docs/images/shared-brain-flow.drawio.png)](docs/images/shared-brain-flow.drawio.png)

Living Brain provides persistent memory for cases and plans. The architecture pairs it with an Obsidian-compatible Markdown knowledge base for research notes, rules, and reviews. Agents can use their own working context while handing off source references and open questions. New evidence creates a new snapshot. The original snapshot stays available for replay, and feedback links to the exact strategy and parameter versions that produced the result.

## What you can verify

| Component | Evidence in this release |
| --- | --- |
| **CoinMarketCap** | [Market adapters](src/astarter-frontend/market-source-adapters.mjs) normalize Pro API market, category, and sentiment data into the Market Hub. |
| **Atlas on BNB Chain** | [Feed catalog](src/astarter-frontend/atlas-feed-master.mjs) maps NVDAB to Atlas feeds. The packaged adapter reads Pull quotes with source timestamps when configured. [Feed #1005](https://atlasoracle.io/feeds/1005) also exposes a public BNB Chain Push reference that can be checked independently. |
| **Living Brain** | [Memory adapter](src/astarter-frontend/living-brain.mjs) captures and recalls wallet-scoped trading plans through the API. [Tests](src/astarter-frontend/living-brain.test.mjs) cover identity hashing and redaction. |
| **Simulation and risk** | [Engine and evidence guides](src/astarter-backend/README.en.md) cover preflight checks, simulated fills, and execution replay. |

The local demo runs in simulation mode. Continuous cross-agent scheduling, public beta publishing, and automatic feedback ingestion are design targets.

## Run the three-layer paper trade

The [Deep Brain module](src/deep-brain) includes public market collection, strategy selection, position sizing, paper execution, memory storage and model review. Clone the repo, enter `src/deep-brain` and run `npm run demo` followed by `npm run verify` to reproduce a stopped-out BTC trade without credentials.

## Frontend packages

The default frontend directory follows the deployed `HACKATHON` branch. It opens Deep Brain, where you can select a research asset and explore the evidence behind each graph node. The [hosted demo](https://dapp.ipfund.art/) also includes a licensed particle portrait. The open repository uses the interactive evidence graph as its opening view.

Open **Historical blocks** on the [Hackathon site](https://dapp.ipfund.art/) for Bitcoin and Ethereum from January 2016, BNB Smart Chain from its first non-genesis block, and dated native Solana and HyperCore samples. Complete-day series and sampled series are identified in the viewer. Select a chain and UTC date to inspect archived heights or slots, timestamps and transaction counts. The [summary](src/astarter-frontend/brain-evidence/archive/summary.json) reports current dates and actual counts. The [manifest](src/astarter-frontend/brain-evidence/archive/manifest.json) records source evidence and SHA-256 checksums.

**Traditional markets** includes listed shares, indices, precious metals, currencies, crude oil and other commodities from 2016. Each observed price retains the publisher, unit, observation date and frequency. Ethereum, Arbitrum and Avalanche Chainlink series identify the feed, round, source update time and historical read block. WTI spot and the WTI futures reference are separate instruments. [Sources, rights and date coverage](src/astarter-frontend/docs/brain-tradfi-sources.md) · [Market catalog](src/astarter-frontend/brain-evidence/tradfi/catalog.json) · [Daily update runs](https://github.com/brunopike/astarter-bnb-bangkok/actions/workflows/brain-history.yml).

The [frontend release](https://github.com/brunopike/astarter-bnb-bangkok/releases/tag/v0.7.0-frontend) contains the tested source snapshot with checksums. The main branch receives daily verified data updates. The [separate historical feature snapshot](https://github.com/brunopike/astarter-bnb-bangkok/releases/tag/v0.5.0-frontend) remains available.

## Run locally

Use Node.js 24 with npm.

```sh
cd src/astarter-frontend
npm ci
npm start
```

Open [Astarter on localhost](http://127.0.0.1:4188/). The public Atlas catalog works without an API key.

```sh
curl -fsS 'http://127.0.0.1:4188/api/atlas/feeds?symbol=NVDAB'
```

The optional live adapters read server-side configuration for CoinMarketCap (`COINMARKETCAP_API_KEY`), Atlas (`ATLAS_API_KEY`), and Living Brain (`LIVING_BRAIN_API_KEY`, `LIVING_BRAIN_SUBJECT_ID`, `LIVING_BRAIN_BRAIN_ID`).

<details>
<summary>Reproduce the BNB Chain price read and run focused checks</summary>

With Foundry, query the Atlas Push reference for NVDAB using a read-only call. The second value is the price at 18 decimals. The fourth is the on-chain update timestamp.

```sh
cast call 0xf25af12920d408baf6211e9e90eda89df3d8ccda \
  'latestRoundData()(uint80,int256,uint256,uint256,uint80)' \
  --rpc-url https://bsc-dataseed.bnbchain.org
```

From `src/astarter-frontend`, run the catalog, adapter, memory, and simulated checkout checks.

```sh
node --import ./test-locale.mjs --test atlas-feed-master.test.mjs market-source-adapters.test.mjs living-brain.test.mjs commerce.test.mjs
```

The earlier [v0.1.0 release](https://github.com/brunopike/astarter-bnb-bangkok/releases/tag/v0.1.0) contains the combined frontend and backend source snapshot.

</details>
