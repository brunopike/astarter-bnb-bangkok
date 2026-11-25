# Astarter PUBLIC distribution / 公共数据分发包

中文：这里完整保留 `brunopike/astarter-backend@3270c8019259c344ac87a8cb811b04a342e0bd61` 的已提交入口、39 个共享来源文件、原测试、锁文件与 Vercel 配置。它是独立分发快照，不自动从旁边的 Core 导入同名模块，也不代表本次已部署。

English: A complete snapshot of the committed PUBLIC entrypoint, 39 shared source files, original tests, lock and Vercel configuration. It is independently versioned; never mix modules from the adjacent Core directory or treat packaging as deployment.

- Provenance / 来源：`source-manifest.json`，根目录 `source-index.json`。
- Four shared dependencies differ from newer Core / 与较新 Core 存在四项明确版本差异，见根 `docs/current-status.md`。
- The standard entrypoint retains bounded on-demand public Binance reads. Synthetic preview and live factories keep their original explicit guards / 普通入口、合成预览、持久 live 工厂保留各自原边界。
- No paid source, collector, database migration, wallet, PRIVATE result or trade is activated by adding this directory / 打包不启用这些权限。
- `vercel.json` is only this service's config. No deployment was configured or executed here; verify external Git integration and Root Directory before release / 本次未配置或执行部署，发布前核对外部 Git 集成与实际目录。

From this directory / 在此目录使用仓库安装好的依赖：

```sh
PYTHONPATH=. ../../services/engine/.venv/bin/python -B -m unittest discover -s tests -v
```

Use a new Python process. Tests use the original fixtures/mocks; they do not certify cloud data, mobile freshness or a production SLA / 不代表真实云数据或手机联调验收。
