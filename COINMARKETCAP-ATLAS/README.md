# CoinMarketCap × Atlas

Astarter’s Market Hub answers two different research questions. CoinMarketCap provides context for a market move across assets and sectors. Atlas provides a timestamped USD reference for an individual asset, including tokenized equities on BNB Smart Chain. A trader can examine the broader market and pass a precise quote to an agent through the CLI. [Market Hub](https://dapp.ipfund.art/?page=markets&lang=en) · [Astarter CLI](../src/astarter-cli/astarter.mjs)

| In the product | How the data is used |
| --- | --- |
| Market overview | Global market cap, 24-hour volume and BTC dominance come from the CMC Pro global metrics request when available. The adapter retains the provider’s update time. |
| Assets, sectors and sentiment | Separate requests fetch the top 50 USD listings, cryptocurrency categories and up to 90 Fear & Greed observations. The adapter normalizes them for the Market Hub. |
| Tokenized equity research | The feed catalog resolves `NVDAB` to **934**. The server requests Atlas’s latest Pull report and exposes its price and timestamp. Agents can read the result with `node src/astarter-cli/astarter.mjs markets NVDAB`. |

The server holds the upstream credentials. If the primary request fails, the relay returns CoinGecko market data or the Alternative.me sentiment index and records the provider that answered. Cached responses carry the same source and timestamp. The Atlas adapter returns `configured: false` when its key is absent. [Endpoint mappings and fallback](../src/astarter-frontend/market-source-adapters.mjs) · [Feed selection](../src/astarter-frontend/atlas-feed-master.mjs) · [CoinMarketCap API](https://coinmarketcap.com/api/documentation/)

## Inspect the public responses

Run these requests with `curl` and `jq`. Market capitalization and price change with each update. The timestamp on each row tells the reader when the provider observed it.

```sh
curl -fsS 'https://dapp.ipfund.art/api/market-hub?resource=global' |
  jq '{source, marketCapUSD: .body.data.total_market_cap.usd,
       btcDominancePct: .body.data.market_cap_percentage.btc,
       updatedAt: .body.data.updated_at}'

curl -fsS 'https://dapp.ipfund.art/api/atlas/prices?symbol=NVDAB' |
  jq '{configured, NVDAB: .prices.NVDAB}'
```

For a second observation of NVDAB/USD, read Atlas feed **1005** directly on BNB Smart Chain. Its contract supplies an independently updated reference price. [Verify the token and oracle on chain](../BNB-CHAIN-RWA/README.md)
