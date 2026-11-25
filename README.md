# LensWave at BNB Bangkok

LensWave turns market research into trading decisions you can inspect and rehearse before committing capital. Astarter’s AI Trading OS brings market data, strategy review, and execution simulation into one workspace.

[Download v0.1.0](https://github.com/brunopike/astarter-bnb-bangkok/releases/tag/v0.1.0) · [BNB Bangkok challenge](https://www.hackquest.io/zh-cn/hackathons/BNB-Bangkok)

## What the build includes

- **Market data.** CoinMarketCap adapters normalize market, category, and sentiment data into the Market Hub. The Atlas adapter maps symbols to feed IDs and reads configured Pull quotes with their source timestamps.
- **Research and strategy.** LensWave organizes market evidence, strategy parameters, and risk review. The optional Living Brain adapter supports research memory.
- **Execution rehearsal.** The backend contains preflight checks, historical and simulated execution, and order and fill evidence for replay.

The BNB Bangkok project explores how an agent can use market references to review BNB Chain trades. The source includes the market adapters and simulation workflow. The original BNB Chain swap preflight is a project direction and can be explored separately from the included local demo.

## Source layout

| Directory | Contents |
| --- | --- |
| [Frontend](src/astarter-frontend) | LensWave browser UI, local server, and provider adapters |
| [Backend](src/astarter-backend) | Trading engine, simulation, API contracts, and distribution sources |

## Run locally

Use Node.js 24 with npm. The server binds to localhost.

```sh
cd src/astarter-frontend
npm ci
npm start
```

Open [LensWave on localhost](http://127.0.0.1:4188/). Inspect the Atlas feed catalog without credentials.

```sh
curl -fsS 'http://127.0.0.1:4188/api/atlas/feeds?symbol=NVDAB'
```

Set `COINMARKETCAP_API_KEY` and `ATLAS_API_KEY` as server-side environment variables to enable those providers. See the [backend setup guide](src/astarter-backend/README.en.md) for Python 3.12, dependency locks, and the simulation engine.

## Verify the release

Run the adapter, research-memory, and simulated-checkout checks from the frontend directory.

```sh
node --import ./test-locale.mjs --test atlas-feed-master.test.mjs market-source-adapters.test.mjs living-brain.test.mjs commerce.test.mjs
```

The release includes a versioned source ZIP and a SHA-256 checksum. To verify a downloaded copy, put both files in the same directory and run `shasum -a 256 -c SHA256SUMS.txt`.
