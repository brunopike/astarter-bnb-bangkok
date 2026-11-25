# 当前后端的本地安装与验证

从仓库根目录操作；这里不再启动旧 Next.js 参考前端。

## 环境

- Python 3.12.4、uv 0.12.7 与 `services/engine/uv.lock`。
- 后端静态 capability 工具使用 Node 22.22.3 和标准库，不依赖旧前端或 npm 安装。
- 完整原生历史／回测验收支持 macOS 26 / Apple silicon 的原子发布与进程协议。
- 不复制 `.venv`、运行 `var/`、数据库或秘密文件。根 `.env.example` 仅列 PRIVATE 配置名，不是有效目标或租约。

```sh
uv python install 3.12.4
uv sync --project services/engine --all-extras --locked
PYTHONPATH=services/engine/src uv run --locked --project services/engine pytest tests services/engine/tests/unit/domain services/engine/tests/unit/control/postgres/test_private_draft_contracts.py -q -p no:cacheprovider
```

## 分发包测试

分别启动新 Python 进程并将 `PYTHONPATH` 设为当前分发目录，不能用 Core 的同名已安装包代替导出闭包：

```sh
(cd deployments/public && PYTHONPATH=. ../../services/engine/.venv/bin/python -B -m unittest discover -s tests -v)
(cd deployments/private && PYTHONPATH=. ../../services/engine/.venv/bin/python -B -m unittest discover -s tests -v)
```

上述测试使用各自原有的 fixture/mock 和默认关闭路径。若要运行更广的后端回归：

```sh
PYTHONPATH=services/engine/src uv run --locked --project services/engine pytest services/engine/tests/unit services/engine/tests/contract -q -p no:cacheprovider
```

原生 PG 用例只有持有本轮新建、受控的测试 fixture 和 marker 才能启用；未启用要诚实报告 skipped，不能发现现用 DSN 或把合成检查说成云验收。

## 本地 PRIVATE 关闭态

在独立 checkout、六项 PRIVATE 配置全部未设置的终端中，可以启动默认关闭的本地入口：

```sh
cd deployments/private
PYTHONPATH=. ../../services/engine/.venv/bin/python -B -m uvicorn app:app --host 127.0.0.1 --port 49340
```

缺配置应给出 `503 PRIVATE_UNCONFIGURED`，而不是连接数据库或模型。用 Ctrl-C 关闭该终端拥有的进程。不要修改共享环境、发现其他服务的秘密，或为看到成功页面伪造 target/lease。

PUBLIC 标准入口有原有的按需公开 Binance 读取能力，不应当作零上游 IO 的演示服务器随意启动和请求；离线检查使用测试。持久 live 工厂和付费源是另一个显式配置边界。

## 静态与秘密检查

```sh
uv run --locked --project services/engine ruff check services/engine/src services/engine/tests services/engine/scripts
uv run --locked --project services/engine mypy --config-file services/engine/pyproject.toml services/engine/src
node --test scripts/tests/scan-forbidden-capabilities.test.mjs
node scripts/scan-forbidden-capabilities.mjs
uv run --locked --project services/engine python services/engine/scripts/scan_secrets.py
```

既有秘密扫描器仍会对后续目录/资源 pin 及合成 canary 产生已知候选；新增来源索引和分发目录也须纳入实际检查，不把退出非零隐藏成通过。先审实际文件与值的来源，不放宽未知密钥、路径或熵规则。

根 GitHub Actions 只接受手动触发，运行仓库检查、后端 unit／contract、后端 capability 门禁、分发包离线测试和 fail-closed 秘密扫描。它不安装旧前端、跑浏览器、部署服务或接收真实模型／数据库秘密。未执行的 CI 没有通过结论，扫描器已知候选仍会以非零状态如实暴露。
