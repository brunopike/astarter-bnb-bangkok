# Astarter frontend deployment

- Application: the existing port 4188 frontend. The marketing site and deck have separate deployments.
- Repository: `brunopike/astarter-frontend` (private).
- Vercel project: `astarter-frontend`, personal scope `starktrump69-5126s-projects`.
- Production domain: `https://astarter.imstark.site`.
- Production branch: `main`; Vercel's native GitHub integration builds each push.

## Release and rollback

Use this checkout. Review `git diff`, run `npm run build`, then commit the intended source changes and push `main`. Vercel installs the lockfile with `npm ci`, builds the four existing UI bundles, exports the public asset allowlist to `dist/`, and runs the deployment tests. A failed build must not replace the current production deployment.

Check the Vercel deployment's Ready status, `/release.json` commit, core page routes, `/api/market-hub` and `/api/v1/data/markets` before treating an update as live. Verify public data with the existing `public-data-client.mjs` contract, including query selection, quality and source timestamps. To reverse a faulty release, use Vercel's previous successful production deployment, then revert the corresponding source commit so the next push preserves the correction.

Preview branches retain Vercel deployment protection. This application deployment is noindex; that is crawler guidance, not access control. Source is private, while production frontend assets are publicly downloadable.

## Deployment boundary

The frontend and public, read-only market relay deploy together. Local paper trading remains simulation-only. This release does not enable real trading or charging.

AI Spectrum now defaults to closed-candle technical observations for its eight supported assets. Source, session, units and expiry are validated before research uses a scanner row. Unconnected liquidity, on-chain, macro-event, social and account-risk sources remain unavailable; technical observations cannot authorize a trade. Explicit `?research=demo` retains the scripted research preview. Saved preview conclusions are not restored into live observations.

The main AI Wealth route exposes four candidate products and their draft terms. Production shares and funding remain unavailable; the existing local test-chain view can load only after an explicit action against a verified localhost chain-31337 service. Wealth server modules and credentials are excluded from the public asset export.

The wallet issuer and private research HTTP adapters are implemented with fixed internal RPC routes; they fail closed until their private service is configured and verified. Production identity, durable request ownership, the global monthly USD ledger and a restricted provider key must all be configured and verified before model calls can run. Missing dependencies fail closed. The adapter pins the model/provider and price ceilings; unknown charges retain their USD reservation.

Public reads under `/api/v1/data/:path*` forward to `https://astarter-backend.vercel.app/v1/data/:path*` through Vercel's native rewrite, preserving the query, status and response body. Responses use `no-store`, and rewrite caching is disabled. The independent backend repository is `brunopike/astarter-backend` (private). Its current scope is Binance spot statistics for BTC, ETH and SOL; unconfigured asset/news sources remain unavailable, and explorer capabilities remain untested. Select **Read-only data** in the existing data pages to use this service; demo data remains separate. This does not provide a persistent collector, global quota, or continuous trading runtime.

Wallet routes use the production issuer adapter at `/api/wallet/*`; research uses `/api/research/*`. Both require a separate PRIVATE backend. Missing issuer/runtime configuration returns 503, while a configured anonymous wallet session returns null and research requires authentication. A login outage does not block the browser-wallet connection picker. Commerce/workspace persistence, external notifications, private exchange connections and unsupported `/api/v1` recommendations remain unavailable. They do not acknowledge payments or claim to send notifications. Browser data remains specific to its origin; local 4188 data is not migrated.

Only files listed by `releaseAssets` in `public-assets.mjs` plus generated wallet bundles enter the public output. Tests, server implementation, environment files, local databases, internal evidence and dependency source trees outside the explicit browser allowlist are excluded. `.gitignore` excludes local secrets and generated files from the private repository as well.

Model dispatch is disabled by default. Only the exact `ASTARTER_RESEARCH_MODEL_ENABLED=1` enables new model admissions; leave it unset during wallet and research-stub integration. Authentication, original-request GETs and replay of existing requests remain available while new admissions return `MODEL_UNAVAILABLE` before provider checks, reservations or source/model calls. No provider account limits are changed by this setting.

Provider key hard-cap verification is required by default. If the owner explicitly defers that provider setting, use the server-only `ASTARTER_RESEARCH_PROVIDER_CAP_REQUIRED=0`; all other values retain verification. This skips only the provider `/key` limit check. The authenticated PRIVATE lease, current UTC month's shared budget of at most USD50 including reserved service costs, atomic Core claim, conservative per-request USD hold and original-ID recovery remain mandatory. This setting neither enables model dispatch nor changes the provider key or its limits. Unknown dispatch outcomes retain their hold and are not automatically retried.

Wallet issuer timestamps may use the database clock instead of echoing the caller's milliseconds. The wallet adapter accepts that trusted canonical timestamp within five seconds of the request, preserves it in the signed SIWE message, and enforces the exact five-minute challenge and seven-day issued-session lifetimes. Expired records receive no grace period; identity, permission, replay and revocation checks remain required.

Wallet issuer calls use the private client's bounded five-second default. Browser nonce and message calls allow 15 seconds for two sequential issuer calls; verification allows 35 seconds to receive the hosted 30-second function response. Session and logout calls retain ten seconds. Renewing a challenge samples its new issuance hint after revoking the old challenge. A timeout still preserves an unknown mutation outcome and never triggers an automatic mutation retry.

Private HTTP adapters require `ASTARTER_PRIVATE_SERVICE_ORIGIN` and separate `ASTARTER_PRIVATE_ISSUER_TOKEN` / `ASTARTER_PRIVATE_RUNTIME_TOKEN` credentials. Research additionally requires `ASTARTER_RESEARCH_LEASE_JSON`; new analyses also require the pinned `ASTARTER_RESEARCH_MODEL` and a dedicated `OPENROUTER_API_KEY` with a monthly cap no greater than USD 50. Without that model key, original-request GETs of stored research records remain available under the same session, lease and owner checks, while new analyses and replays return `UNCONFIGURED` before provider checks, reservations or source/model calls. The PRIVATE monthly ledger must subtract fixed service commitments before model reservations. An uncapped provider key is rejected before research reservation or dispatch. Unconfigured endpoints remain unavailable. These settings belong only in Vercel encrypted environment settings; never export them as browser assets. `WALLETCONNECT_PROJECT_ID` is an optional public Reown project identifier used by `build-wallet.mjs`; its allowed origins must include the deployment domain before mobile WalletConnect can be considered available. Keep any future private credentials in Vercel environment settings, never in browser code or Git.

## Runtime

Node.js 24, npm lockfile v3, native ESM. Vercel serves `dist/`, the existing `/api/market-hub` function and the private wallet/research HTTP adapters. Wallet has a 30-second function ceiling, research 60 seconds; clients retain the original request identity when a research outcome is unknown. Public upstream providers can rate-limit or fail; their existing error/quality states remain visible.
