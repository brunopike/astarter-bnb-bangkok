# Astarter PRIVATE R3 distribution / 私人研究分发包

中文：这里基于 `brunopike/astarter-private-research@551904a3c2dc32de64be52de06f14bff39fe9d47` 的完整本地 R3 候选，另显式同步 2026-11-18 的 Neon v2 精确目录兼容。49 个来源文件与当前 Core 一致，连同入口、原测试、新增兼容回归、依赖和 Vercel 配置一并提供；本地增量见 `source-manifest.json`。`NEON_DRAFT_PIN=None`；它仍不是已通过的 Neon v3 或生产发布。

English: Complete local R3 release candidate with an explicit November 18 exact Neon-v2 compatibility delta. Includes 49 source files matching current Core, entrypoint, original and compatibility tests, dependencies and Vercel config; local changes are recorded in `source-manifest.json`. `NEON_DRAFT_PIN=None` remains closed; this is not accepted Neon v3 or an activated production release.

- Provenance / 来源：`source-manifest.json`，根目录 `source-index.json`。
- Six server-only values are required: `ASTARTER_PRIVATE_TARGET_JSON`, `ASTARTER_PRIVATE_LEASE_JSON`, `ASTARTER_PRIVATE_RUNTIME_DATABASE_URL`, `ASTARTER_PRIVATE_ISSUER_DATABASE_URL`, `PRIVATE_RUNTIME_TOKEN`, `PRIVATE_ISSUER_TOKEN`. Values are never included here / 这里只提供名称，不带真实值。
- Missing configuration returns `503 PRIVATE_UNCONFIGURED`; default import starts no DB/model call / 默认关闭不访问数据库或模型。
- issuer/runtime/cost, source time, wallet Origin/audience, tenant, transaction, budget and recovery gates remain unchanged / 现有全部门禁保持原样。
- Drafts have no execution authority. Existing schema2 runtimes cannot serve schema3; require an independently accepted profile and compatible recovery candidate before migration / 迁移前必须独立验证 profile 与恢复方案。
- Nothing in this directory resumes Q08/S03, publishes Vercel or starts a paid model / 不恢复暂停或启动外部操作。
- The additional full catalog pin applies only to Neon schema-v2; platform-grant origin remains a WATCH. LOCAL/v1/v3 and all identity/resource/permission checks stay strict / 精确额外指纹只对 Neon v2 生效，平台授权的来源归因仍待补证。

From this directory / 在此目录独立进程验证：

```sh
PYTHONPATH=. ../../services/engine/.venv/bin/python -B -m unittest discover -s tests -v
```

Only the separately authorized environment may provide secrets. Never copy issuer credentials to the browser / issuer 秘密不得进入浏览器。
