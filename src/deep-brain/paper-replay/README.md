# Deep Brain paper trading

Use Node.js 24 or later. From the directory that contains `paper-replay/`, run:

```sh
node paper-replay/cli.mjs demo --store ./paper-memory
node paper-replay/verify.mjs
node paper-replay/cli.mjs serve --port 4317
```

Open [the paper trade review](http://127.0.0.1:4317/). The built-in HTTP server also exposes the read-only [proof API](http://127.0.0.1:4317/api/brain/proof). The demo, independent verifier, memory and web server work offline without an account or package installation. The CLI prints the memory ID, chosen strategy, position limit, execution receipt, fees and net P&L.

## Data and verification

The CLI reads the market archive at runtime. Pass your own archive and asset key to inspect another market. The verifier checks the fingerprints, decision cutoffs, frozen price windows, candidate selection, position ceiling, simulated costs and balance changes from those inputs.

## Run your own session

```sh
node paper-replay/cli.mjs demo --archive brain-evidence/daily-markets.json --asset coin:ethereum --days 90 --store ./paper-memory
node paper-replay/verify.mjs --archive brain-evidence/daily-markets.json --asset coin:ethereum
node paper-replay/cli.mjs recall MEMORY_ID --store ./paper-memory
```

Replace `MEMORY_ID` with the ID printed by `demo`. Each memory is an immutable local JSON file. Repeating the same replay reuses its ID. Explicit dates can select a cash decision. With no date the CLI chooses the latest fill in the window, or the latest decision when there are no fills. The local memory ID fingerprints the complete replay note. The execution receipt ID identifies the simulated transaction within it.

## Collect market data and register future paper sessions

```sh
export ASTARTER_BRAIN_FORWARD_DIR="$PWD/paper-forward"
node scripts/brain-proof-forward.mjs --refresh
```

The collector uses Python 3, curl and public Binance Spot / Coinbase Exchange candle endpoints on macOS or Linux. Run the same worker on later days to reconcile sessions once their target candles close. It verifies the venue before registration, persists evidence and paper handoffs, and validates the later settlement. Source failures and stale candles are reported. A historical replay cannot create a backdated forward receipt. To replay a refreshed archive, pass `--archive "$ASTARTER_BRAIN_FORWARD_DIR/daily-markets.json"`. The server and worker must share the same directory to serve forward records. See `docs/brain-proof.md` for API routes and timing.

## Read a memory with your own model

Set `OPENAI_API_KEY` in your shell or secret manager, and optionally set `OPENAI_MODEL` to a Responses API model available to your account. Running the following command sends one real, billable request with the saved memory as input:

```sh
node paper-replay/cli.mjs explain MEMORY_ID --store ./paper-memory
```

For hosted memory, configure your own `LIVING_BRAIN_API_KEY`, `LIVING_BRAIN_SUBJECT_ID` and `LIVING_BRAIN_BRAIN_ID`. The sync command saves the paper record, waits for compilation, and checks the content hash after reading it back. Repeating a sync checks for an existing capture with the same origin reference. To explain the bytes read from Living Brain:

```sh
node paper-replay/cli.mjs sync MEMORY_ID --store ./paper-memory
node paper-replay/cli.mjs explain MEMORY_ID --store ./paper-memory --remote
```

Market data, replay, model explanation and hosted memory are independent operations. No exchange credentials or order-placement adapter are used.
