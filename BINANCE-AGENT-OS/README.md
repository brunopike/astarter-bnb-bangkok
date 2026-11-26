# Binance Agent OS

When a trader asks whether a move has liquidity behind it, Astarter’s assistant can inspect the Binance book and attach that snapshot to the conversation. The exchange name, instrument and observation time travel with the figures, so another agent can tell which market the answer describes. [Assistant tools](../src/astarter-frontend/assistant-exchange-tools.mjs) · [Snapshot handling](../src/astarter-frontend/assistant-exchange-data.mjs)

Binance Agent OS offers exchange APIs, MCP tools, skills and Agentic Wallet. Astarter uses the Binance REST APIs for research and directs wallet holders to a separate BNB Smart Chain address-verification flow. Each path asks for a different level of access. [Binance Agent OS](https://www.binance.com/en-ZA/agent-os) · [Agentic Wallet in Astarter](AGENTIC-WALLET.md)

| Question | What Astarter reads | Access |
| --- | --- | --- |
| What changed in the spot market? | 24-hour ticker, ten price levels on each side of the book, or up to 60 candles. The analysis uses closed candles. | Public |
| What does the perpetual market say? | USDⓈ-M funding and mark-price data for the selected symbol. | Public |
| What does this account hold? | Spot balances, USDⓈ-M positions or up to 50 recent spot fills for the selected pair. | Verified read-only Binance API key |

For account reads, the local relay checks the key’s permissions with Binance, rejects trading or withdrawal permissions, and verifies an account read before opening a 30-minute session. It signs allowlisted upstream GET requests using Binance server time. Disconnecting the session releases its credentials. [Exchange relay](../src/astarter-frontend/assistant-exchange-relay.mjs)

## Inspect one market snapshot

Start the [local dApp](../README.md) and run the following request. The response identifies the provider, instrument and observation time. This public read needs network access to Binance and no account credentials.

```sh
curl -fsS -H 'X-Astarter-Exchange: 1' \
  'http://127.0.0.1:4188/api/assistant/exchanges/binance/orderbook?asset=BTC'
```

From the repository root, exercise the relay offline, including stale data, session expiry and rejection of unsupported operations.

```sh
node --import ./src/astarter-frontend/test-locale.mjs --test src/astarter-frontend/assistant-exchange.test.mjs
```
