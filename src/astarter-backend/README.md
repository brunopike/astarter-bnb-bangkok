# Astarter Backend

[中文](README.md) | [English](README.en.md)

这是最近一轮 **Astarter / Lego AI Quant** 工作的完整后端仓库，收齐后端实现、PUBLIC／PRIVATE 两个独立部署包、接口合同、SQL、测试、依赖锁和当前交接说明。产品前端继续使用 [astarter-frontend](https://github.com/brunopike/astarter-frontend)，本仓库不再包含早期的参考前端 `apps/web`。

> 这里按产品用途组织当前成果，不按文件日期拼接代码。当前 Astarter 仍依赖的基础代码、迁移和回归测试完整保留。旧参考 UI、旧 UI 启动工具及早期过程记录已移出默认分支；Git 历史保留，未改写日期或强推历史。

## 当前有哪些能力

| 部分 | 已实现的内容 | 尚未完成或当前限制 |
| --- | --- | --- |
| 数据中心 | Binance／CoinGecko／BlockBeats 适配、来源时钟、共享 PUBLIC 快照、全局配额、受控刷新和失败降级 | 具体真实来源由入口与显式配置决定；BlockBeats 当前额度待核实，未因整理仓库启用付费来源或持续采集 |
| 18 个 Agent | A01–A18 合同、角色注册、依赖与按需调度 | 按任务选择角色；不是每次同时调用 18 个模型 |
| 研究流程 | ResearchService、PUBLIC／PRIVATE 复用、身份隔离、任务领取、CAS、预算预留、结果落库、取消与 UNKNOWN 恢复 | Q08 已交付流程主要为本地合成验证，后续开发暂停；不会自动启动 worker |
| 机会与推荐 | DTO、来源／风险／缓存约束、现有研究结果的只读投影和独立 GET 读层 | `OFFLINE_REFERENCE`，不是交易或付款批准；不同读层仍按原互斥配置接线 |
| 私人应用 | issuer／runtime／cost 身份分离、挑战与会话、研究结果、UI 工作区及通知持久化 | 依赖已验的目标、租约、角色和 schema；源码不携带这些真实秘密或运行数据 |
| R3 策略草稿 | 报告来源与参数绑定、草稿版本和头、幂等命令、冲突检查及恢复 | 本地候选已审；Neon schema-v3 仍未验收，`NEON_DRAFT_PIN=None`，未启用生产 |
| 模拟交易与证据 | NautilusTrader 历史／模拟运行、确定性风控、订单／成交／仓位报告和可追溯回放 | 不代表实盘准入或 18 种策略全部完成；S03 后续开发暂停 |

最新交付状态与接续条件见 [当前状态](docs/current-status.md)，组件关系见 [架构与边界](docs/architecture.md)。上传源码不等于部署、迁移、实盘、模型成功或资金到账。

## 一份仓库里的完整结构

```text
services/engine/             当前 Astarter 后端主实现、全部核心测试和 Python 锁文件
  src/stark_trading_os/
    control/                API、应用组合、任务／运行控制
      postgres/             DAL、连接池、身份权限、迁移与 profile
      research/             研究服务和机会／推荐只读投影
    domain/                 Agent、策略、预算和风控合同
    integrations/           数据／模型／工具端口与受控适配器
    runner/                 原生历史与模拟执行
    audit/                  哈希、封存、回放和证据
deployments/public/         可独立安装的 PUBLIC 服务快照：入口、完整导出闭包、测试、锁和 Vercel 配置
deployments/private/        可独立安装的 PRIVATE R3 候选：入口、完整导出闭包、测试和 Vercel 配置
contracts/                  接口合同及前后端共用的 Astarter 草稿 fixture
data/fixtures/              当前模拟和回归测试仍需的固定 QA 数据，不是运行数据库
docs/development/           已交付 Astarter 模块说明
docs/contracts/             当前实现对应的冻结设计合同，内容字节保持原样
docs/runbooks/              当前后端的安装、验证与恢复说明
tests/                      仓库完整性与分发包封闭性验证
source-index.json           来源提交与文件 hash 索引
```

内部包名 `stark_trading_os` 保持兼容。原有 463 个核心文件齐全，另有一份后端测试必需的固定 JSON 样本及一份目录兼容回归。2026-11-18 在 Core 与 PRIVATE 分发包中同步了 Neon schema-v2 的精确目录兼容；两处生产 Python 变更及测试的前后 hash 均有记录，SQL 字节和秘密扫描规则未改。两个导出包各自保留完整入口依赖，不能任意混用模块。

该兼容只额外接受一份完整目录指纹，保留原 pin、应用身份与权限、资源和 metadata 校验；LOCAL、v1、未验证的 Neon v3 均不获额外通行。平台九项默认授权来自实际目录的本地重建，仍有来源归因 WATCH，不能把它当作新的官方 oracle。范围与验收见 [Neon v2 兼容说明](docs/development/2026-11-18-neon-v2-catalog-compatibility.md)。

## 版本从哪里来

| 组成 | 固定来源 |
| --- | --- |
| 后端主实现 | `d59c318cc00222e587cd9d53023a3fa18884af16`，2026-11-17 |
| PUBLIC 分发包 | `astarter-backend@3270c8019259c344ac87a8cb811b04a342e0bd61` |
| PRIVATE 分发包 | `astarter-private-research@551904a3c2dc32de64be52de06f14bff39fe9d47`，本地 R3 候选 |
| 产品前端关联 | 独立仓库 `astarter-frontend`；本轮参考 `0fafd9870ca9d2d31cbdec2d8b66baffca131e66` |

[source-index.json](source-index.json) 和各部署包的 `source-manifest.json` 固定实际字节。PUBLIC 包沿用其已审来源，和主实现有四个已记录的公共依赖版本差异；PRIVATE 的 49 个导出文件与本期主实现一致。没有把较新 Core 文件偷偷替换进旧的 PUBLIC 发布候选。后续升级分发包须重新验证和更新其清单。

## 安装与离线验证

使用 Python **3.12.4**、uv **0.12.7** 及已提交的锁文件；后端静态安全工具另使用 Node **22.22.3**，不需要安装旧前端或 npm 依赖。完整原生历史验收仍依赖 macOS 26／Apple silicon 的原子发布与进程约束；部分跨平台测试通过不等于完整验收。

```sh
git clone https://github.com/brunopike/Astarter_Backend.git
cd Astarter_Backend
uv python install 3.12.4
uv sync --project services/engine --all-extras --locked

# 当前仓库的来源完整性 + 定向离线合同
PYTHONPATH=services/engine/src uv run --locked --project services/engine pytest tests services/engine/tests/unit/domain services/engine/tests/unit/control/postgres/test_private_draft_contracts.py -q -p no:cacheprovider
```

两个部署包在各自目录运行其原有离线测试，必须使用独立 Python 进程，避免同名 Python 包互相污染：

```sh
(cd deployments/public && PYTHONPATH=. ../../services/engine/.venv/bin/python -B -m unittest discover -s tests -v)
(cd deployments/private && PYTHONPATH=. ../../services/engine/.venv/bin/python -B -m unittest discover -s tests -v)
```

PRIVATE 不提供六项服务端配置时应返回 `503 PRIVATE_UNCONFIGURED`，默认导入不连接数据库或模型。PUBLIC 普通入口保留原有按需公开行情读取能力，测试使用 fixture；新版持久采集工厂仍需显式配置，不因打包而启用。不要把服务端密钥放入前端或提交 Git。

说明与更多命令见 [本地开发与验证](docs/runbooks/local-development.md)。本次未配置或执行部署。外部平台可能另有 Git 关联与 Root Directory 规则，不能仅凭根目录没有 `vercel.json` 判定自动部署关闭；发布前须核实际设置及该版本的验收。

## 维护约束

- 当前代码以 `services/engine` 为实现来源；部署快照通过明确导出和 hash 更新，不在三份同名模块之间随意复制。
- 原始 source／receipt／available／expiry、PRIVATE scope、CAS、owner／epoch、预算和 UNKNOWN 责任不因整理目录改变。
- `SIM_MODEL_CREDIT_V1`、USD 费用、供应商套餐和用户积分分别记账。
- 不携带真实 ENV、DSN、钱包秘密、生产数据库、运行日志或任务目录中的运维回执。
- 既有秘密扫描器仍保留 fail-closed 行为；迁移／目录指纹和合成 canary 的已知告警需逐项审查，不能用宽松过滤制造全绿。

本轮为仓库维护及本地目录兼容修复，不恢复 Q08／S03，不启用真实 API／模型，不追加云测，不迁移现用数据库，不改变 Vercel 项目或生产入口。无新增开源许可。
