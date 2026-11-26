# Astarter at BNB Bangkok · Technical brief

A trader comparing a tokenized equity with the crypto market needs to know who supplied the price, when it updated, and what an agent could know before it acted. Astarter exposes those checks in its Market Hub and records its spot paper decisions before the next session opens.

## Trace the data behind a quote

| Question | Integration | Inspect it |
| --- | --- | --- |
| How broad is a market move? | The server requests CoinMarketCap Pro global metrics, the top 50 USD listings, categories and 90 sentiment observations. The Market Hub uses them for market size, asset rankings, sector context and sentiment. | [Endpoint mappings and fallback logic](../src/astarter-frontend/market-source-adapters.mjs) · [Normalized global metrics](https://dapp.ipfund.art/api/market-hub?resource=global) |
| What is the tokenized equity quote? | On BNB Smart Chain (chain ID 56), the catalog maps NVDAB/USD to Atlas Pull feed **934**. The watchlist uses its price and source timestamp. A separate Atlas Push feed, **1005**, exposes a price and update time through a public contract. The two feeds can update at different times. | [Pull response](https://dapp.ipfund.art/api/atlas/prices?symbol=NVDAB) · [Watchlist implementation](../src/astarter-frontend/market-hub.mjs) · [Push feed and address](https://atlasoracle.io/feeds/1005) |

To check the Push feed, run this read-only call with Foundry. Divide the second return value by 10¹⁸ for the USD price. The fourth value is the Unix update time. To repeat the historical read at [block 135916221](https://bscscan.com/block/135916221), add `--block 135916221` with an archive-capable BNB RPC.

```sh
cast call 0xf25af12920d408baf6211e9e90eda89df3d8ccda \
  'latestRoundData()(uint80,int256,uint256,uint256,uint80)' \
  --rpc-url https://bsc-dataseed.bnbchain.org
```

## Follow a decision across agents

The RWA feed supplies market context. The spot paper engine uses closed candles from its named trading venue. **Brain** pins the evidence at the UTC cutoff. **Thinking** ranks eligible strategies alongside cash, then sizes the selected position against its risk budget. **Execution** rechecks the opening gap, records a fill or a reason to skip, and reconciles costs after the close. The preregistered cash and 10% holding benchmarks make the result comparable on the same sessions. [Inspect a decision](https://dapp.ipfund.art/api/brain/proof?brief=1&asset=coin:bitcoin) · [Verify a decision locally](../src/deep-brain) · [Benchmark code](../src/deep-brain/brain-forward-comparison.mjs)

Across the product, 18 [Team agents](../src/astarter-frontend/simulation.mjs) cover roles from liquidity checks to counter-evidence and attribution. The 18 [Strategy agents](../src/astarter-frontend/strategy-catalog.mjs) specify markets, conditions and risk limits. The current spot engine compares three strategy families with cash. [Binance Agent OS](https://www.binance.com/en-ZA/agent-os) supplies the ecosystem for the assistant’s [Binance research tools](../src/astarter-frontend/assistant-exchange-relay.mjs). Astarter’s [Agentic Wallet setup](https://demo.astarter.io/settings#ux-local-agent) verifies address control on chain ID 56 using an expiring EIP-712 signature. Its scope is address verification.

A local AI agent can reproduce the public reads using the [official Astarter CLI](https://demo.astarter.io/cli/astarter.mjs) with Node.js 20 or later. These commands return JSON for the Atlas quote and the separate spot decision.

```sh
curl -fsSLo astarter.mjs https://demo.astarter.io/cli/astarter.mjs
node astarter.mjs markets NVDAB
node astarter.mjs research coin:bitcoin
```

The Living Brain adapter captures a wallet-scoped plan and retrieves relevant rules and lessons for a later agent. For a paper receipt, it reads the stored source back and verifies the SHA-256 digest before passing its content to the model. [Plan capture and search](../src/astarter-frontend/living-brain.mjs) · [Receipt readback](../src/deep-brain/paper-replay/connections.mjs) · [Tests](../src/deep-brain/paper-replay/replay.test.mjs)

**Next engineering milestone.** Add venue hours and a quote-age check to tokenized equity research so agents can explain when a reference price is usable. For the AWS Credits application, the proposed workload is daily evidence collection, object storage and reconciliation, measured by cost per verified session.

**Team Astarter** · [Repository maintainer](https://github.com/brunopike) · [Contact the team via project issues](https://github.com/brunopike/astarter-bnb-bangkok/issues) · [Official judging criteria](https://www.hackquest.io/hackathons/BNB-Bangkok)
