# Deep Brain paper trading

Run the same decision, risk and execution logic used by the Hackathon demo. The bundled market and recorded model review work offline with Node.js 24 or later. No package installation is required.

```sh
git clone https://github.com/brunopike/astarter-bnb-bangkok.git
cd astarter-bnb-bangkok/src/deep-brain
npm run demo
npm run verify
npm test
npm start
```

Open [the local review](http://127.0.0.1:4317/). The November 5 BTC/USDT case stopped out for a modeled loss of 24.8936 USDT after fees and slippage. You can inspect each step and choose another session or market.

| Layer | What runs | What you can check |
| --- | --- | --- |
| Brain | Collect public closed candles, match the venue, store the observation and recall saved evidence. | Source URL, UTC cutoff, original candle values and hashes. |
| Thinking | Evaluate eligible pullback, trend, breakout and cash candidates on the prior window. Size the selected position against the risk policy. | Signal eligibility, calibration sample, candidate scores, risk budget, and reasons to hold cash. |
| Execution | Simulate entry, stop or close, slippage and fees. Reconcile account equity and persist the receipt. | Price movement, cost attribution, net P&L, immutable memory and optional model review of the exact recalled bytes. |

[Run on another market, refresh data, write a hosted memory or call your own model](paper-replay/README.md). [Proof API, forward registration, data cutoffs and verification](docs/brain-proof.md).

The historical replay uses a simulated decision clock. The forward worker separately registers future paper decisions and reconciles them after the venue publishes a closed candle. Both paths model execution. Daily candles cannot establish fillable depth or future profitability.

The source code in this directory is available under the [MIT License](LICENSE). Market observations retain their original source attribution and are subject to the respective provider terms.
