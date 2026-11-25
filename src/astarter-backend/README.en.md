# Astarter Backend

[中文](README.md) | [English](README.en.md)

This repository collects the current **Astarter / Lego AI Quant** backend work: the core implementation, complete PUBLIC and PRIVATE distributions, interface contracts, SQL, tests, dependency locks and current handoff notes. The product frontend remains in [astarter-frontend](https://github.com/brunopike/astarter-frontend). The earlier reference frontend, `apps/web`, is no longer included here.

> The repository is organized by current product responsibility, not by a date cutoff. Foundation code, migrations and regressions still required by Astarter are preserved. The old reference UI, its launch tools and early process records have been removed from the default branch. Git history remains intact; timestamps and history were not rewritten.

## Implemented capabilities

| Area | Available implementation | Limitations / unfinished work |
| --- | --- | --- |
| Data center | Binance, CoinGecko and BlockBeats adapters; source clocks, shared PUBLIC snapshots, global quotas, bounded refresh and degradation | Real providers depend on the entrypoint and explicit configuration; current BlockBeats entitlement remains unresolved. Packaging enables no paid provider or continuous collection |
| 18 agents | A01–A18 contracts, role registration, dependencies and on-demand scheduling | Roles are selected per task, not eighteen model calls for every decision |
| Research | ResearchService, PUBLIC/PRIVATE reuse, identity isolation, claims, CAS, budget reservations, persistence, cancellation and UNKNOWN recovery | Delivered Q08 workflows primarily have local synthetic validation. Further work is paused and no worker starts automatically |
| Opportunities | DTOs, source/risk/cache rules, read-only projections and a separate GET read side | `OFFLINE_REFERENCE`, with no trading or payment approval. Read-side modes retain their exclusive composition rules |
| Private application | Separate issuer/runtime/cost identities; challenges, sessions, research, workspace and notification persistence | Requires a verified target, lease, roles and schema. Real secrets and runtime state are not distributed |
| R3 strategy drafts | Report and parameter binding, version/head records, idempotent commands, conflicts and recovery | Locally reviewed candidate; Neon schema-v3 is unaccepted and `NEON_DRAFT_PIN=None`. Not enabled in production |
| Simulation and evidence | NautilusTrader historical/simulated execution, deterministic risk, order/fill/position reports and replay | Not live-trading access or a claim that all eighteen strategies are complete. Further S03 development is paused |

See [current status](docs/current-status.md) and [architecture](docs/architecture.md). Source upload, deployment, migration, live trading, successful model execution and settled funds are separate outcomes.

## Complete repository layout

```text
services/engine/             Current backend implementation, all core tests and Python lockfile
  src/stark_trading_os/
    control/                APIs, application composition and job/run control
      postgres/             DAL, pools, identity, permissions, migrations and profiles
      research/             Research service and recommendation projections
    domain/                 Agent, strategy, budget and risk contracts
    integrations/           Data/model/tool ports and bounded adapters
    runner/                 Native historical and simulated execution
    audit/                  Hashing, sealing, replay and evidence
deployments/public/         Standalone PUBLIC snapshot: entrypoints, full closure, tests, lock and Vercel config
deployments/private/        Standalone PRIVATE R3 candidate: entrypoint, full closure, tests and Vercel config
contracts/                  Interface contracts and shared Astarter draft fixture
data/fixtures/              Fixed QA data still required by simulation/regressions; no runtime DB
docs/development/           Delivered Astarter component notes
docs/contracts/             Frozen contracts for the current implementation, preserved byte-for-byte
docs/runbooks/              Current backend setup, validation and recovery
tests/                      Repository-integrity and distribution-closure checks
source-index.json           Source commits and file hashes
```

The internal `stark_trading_os` package name remains compatible. All 463 original core files are present, plus one required JSON fixture and one catalog regression file. The November 18 update aligns exact Neon schema-v2 catalog compatibility in Core and the PRIVATE distribution. Before/after hashes identify the two production Python changes and their tests; SQL bytes and secret-scanning rules are unchanged. Both distributions retain their full entrypoint dependencies and must not mix versions.

The compatibility path accepts one additional full catalog fingerprint while retaining the original pins, application identity and permissions, resource and metadata checks. It grants no exception to LOCAL, v1 or unverified Neon v3. The nine platform default grants were reconstructed locally from the observed catalog; their origin remains an architectural WATCH, not a new official oracle. See the [Neon v2 compatibility note](docs/development/2026-11-18-neon-v2-catalog-compatibility.md) for scope and acceptance boundaries.

## Source versions

| Component | Fixed source |
| --- | --- |
| Backend core | `d59c318cc00222e587cd9d53023a3fa18884af16`, November 17, 2026 |
| PUBLIC distribution | `astarter-backend@3270c8019259c344ac87a8cb811b04a342e0bd61` |
| PRIVATE distribution | `astarter-private-research@551904a3c2dc32de64be52de06f14bff39fe9d47`, local R3 candidate |
| Related product frontend | Separate `astarter-frontend` repository; reference `0fafd9870ca9d2d31cbdec2d8b66baffca131e66` |

[source-index.json](source-index.json) and each distribution's `source-manifest.json` identify the exact bytes. PUBLIC retains its reviewed source with four recorded shared-dependency differences from Core; PRIVATE's 49 exported files match the current core. Newer Core modules have not been silently substituted into the older PUBLIC release candidate. Distribution updates need an explicit export, verification and manifest update.

## Setup and offline checks

Use Python **3.12.4**, uv **0.12.7** and the committed locks. Backend static security checks also use Node **22.22.3**, without the old frontend or npm dependencies. Full native historical acceptance still requires macOS 26 / Apple silicon for atomic publication and process guarantees. Passing a cross-platform subset is not full acceptance.

```sh
git clone https://github.com/brunopike/Astarter_Backend.git
cd Astarter_Backend
uv python install 3.12.4
uv sync --project services/engine --all-extras --locked

# Source integrity and focused offline contracts
PYTHONPATH=services/engine/src uv run --locked --project services/engine pytest tests services/engine/tests/unit/domain services/engine/tests/unit/control/postgres/test_private_draft_contracts.py -q -p no:cacheprovider
```

Run each distribution's original tests in its own directory and in a separate Python process so the same package name cannot mask a different distribution:

```sh
(cd deployments/public && PYTHONPATH=. ../../services/engine/.venv/bin/python -B -m unittest discover -s tests -v)
(cd deployments/private && PYTHONPATH=. ../../services/engine/.venv/bin/python -B -m unittest discover -s tests -v)
```

Without all six server-side values, PRIVATE should return `503 PRIVATE_UNCONFIGURED`; default import connects to neither database nor model. The ordinary PUBLIC entrypoint retains demand-driven public market reads, while its tests use fixtures. The persistent live-collection factory still requires explicit configuration. Keep server secrets out of browser bundles and Git.

See the [local runbook](docs/runbooks/local-development.md). This change neither configures nor executes deployment. External platforms may have their own Git integration and Root Directory settings; absence of a root `vercel.json` does not prove automatic deployment is disabled. Verify actual settings and version acceptance before release.

## Maintenance rules

- `services/engine` is the implementation source; distributions change through explicit exports and hash updates, not ad hoc copying between three packages.
- Original source/receipt/available/expiry clocks, PRIVATE scope, CAS, owner/epoch, budgets and UNKNOWN responsibility remain unchanged by this reorganization.
- `SIM_MODEL_CREDIT_V1`, commercial USD costs, provider entitlement and user points are separate accounting domains.
- No real ENV, DSN, wallet secret, operational database, runtime log or task-level operational receipt is included.
- The existing secret scanner remains fail-closed. Known catalog/resource fingerprint and synthetic-canary findings require individual review, not broad filters to produce a green result.

This update maintains the repository and repairs local catalog compatibility. It does not resume Q08/S03, activate real APIs/models, add cloud tests, migrate operational databases or change Vercel projects/production entrypoints. No open-source license was added.
