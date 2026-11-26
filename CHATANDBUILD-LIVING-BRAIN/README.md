# ChatAndBuild · Living Brain

A trader revises a strategy’s risk cap. On the next review, an agent can recover the cap, why it changed and which alternative the trader rejected. Astarter uses ChatAndBuild’s Living Brain API to carry those decisions between sessions. [Strategy editor](../src/astarter-frontend/strategy-journeys.mjs) · [Living Brain developer guide](https://docs.livingbrain.com/docs/build)

| Step | What crosses the API |
| --- | --- |
| Remember a decision | Saving a strategy sends a plan and a decision note to the batch capture endpoint. The plan records the market type, venue, instrument, amount and cap. The note records what changed, why, and what was rejected. Their source references share a wallet-derived user key, plan ID and version. |
| Retrieve it for the next review | When the strategy reopens, the adapter searches Living Brain, reads the matching pages and returns three collections. Strategy rules are shared, lessons are filtered by market type, and prior decisions are filtered by the signed-in account’s user key. |
| Check a receipt before model review | The execution adapter computes a SHA-256 digest of the serialized paper record and uses it to find or create a source. It waits for the source to finish compiling, reads back its content, and checks the digest and source reference. The model can then explain those exact bytes, with the receipt ID and input digest attached to its answer. |

[Plan capture and recall](../src/astarter-frontend/living-brain.mjs) · [Receipt verification](../src/deep-brain/paper-replay/connections.mjs) · [Model handoff](../src/deep-brain/paper-replay/cli.mjs)

## Check it in the product

Configure `LIVING_BRAIN_API_KEY`, `LIVING_BRAIN_SUBJECT_ID` and `LIVING_BRAIN_BRAIN_ID` on the local dApp server. Sign in, save a plan in the strategy editor, then reopen the same strategy and market. In the browser’s Network panel, a `202` response with `memory: true` from `POST /api/memory/plan` confirms that Living Brain accepted the capture. A later `GET /api/memory/context` returns the recalled pages after compilation. A local save with `memory: false` means the remote capture was unavailable. [Local setup](../README.md)

The following test uses an injected service response to verify that retries reuse a captured source and that the model receives its exact content. Run it from the repository root without service credentials.

```sh
node --test --test-name-pattern='hosted recall' src/deep-brain/paper-replay/replay.test.mjs
```
