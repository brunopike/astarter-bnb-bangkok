# Astarter 当前交付状态

[中文入口](../README.md) · [English overview](../README.en.md)

本状态对应 2026-11-17 的固定来源及 2026-11-18 的显式本地兼容增量；不是实时控制台。

完整工程仓库已改名为 [brunopike/Astarter_Backend](https://github.com/brunopike/Astarter_Backend)，仓库 ID、历史与分支保留。现有 PUBLIC 部署仓库 `brunopike/astarter-backend` 名称及部署配置不因改名变更。

## 已收齐

- Core `d59c318` 的全部后端源码、测试、SQL 和锁文件，包含 `930abac` 的双时钟修复、R3 草稿实现和填充过的 v2 历史兼容回归。
- PUBLIC 分发包 `3270c801`：实际入口、39 个已封闭的共享来源文件、离线测试、依赖锁和 Vercel 配置。
- PRIVATE 分发包 `551904a`：R3 本地候选，49 个共享来源文件、入口、依赖、配置和默认关闭测试。
- A01–A18、Q01/Q05/Q08、B1a/B1b/B1c、R1/R2/R3 已提交的合同与实现；包含仍被这些模块依赖的原生历史／模拟执行和数据库基础层。
- 当前模块说明、冻结合同、前后端共用草稿 fixture 和来源索引。
- Core 与 PRIVATE 同步 Neon v2 的精确完整目录兼容；原 pin、身份、权限、metadata、资源及版本门禁保留。新增合成协议回归与本地新建 PG17 的目录／授权反例，见 [兼容说明](development/2026-11-18-neon-v2-catalog-compatibility.md)。本轮未新增云端尝试。

## 尚未通过的门槛

1. 新 PRIVATE Neon schema-v3 目录尚未形成已接受的云端 pin，`NEON_DRAFT_PIN=None`。本地 v3 通过不能代替云端迁移、角色或读写验收。
2. 新隔离项目完成了专用角色和密封凭据准备；停止前尚未完成新的应用数据库和 schema-v3 安装。该准备不随源码导入运行，也没有在本次仓库整理中继续执行。
3. R3 前端的本地合成验收与静态预览已完成，但新 QA 数据库链路和生产启用未完成。既有身份合同仍要求 canonical Origin；不为预览放宽 Origin 或 audience。
4. Q08／S03 后续工作暂停。源码和既有回归保留，但不开始持续 worker、真实模型或下一原生执行阶段。
5. 付费数据源须核现有套餐、额度、限流和期限；BlockBeats 当前额度仍待补。不得把历史余量当当前余量。
6. 没有因本次整理追加云测、调整 Neon 配额、更新 ENV、迁移现用数据库、发布服务或启用实盘。
7. Neon v2 额外完整指纹只覆盖已观测平台九项默认授权的本地重建。授权的形成时间、操作者及平台版本尚未归因；这一 WATCH 保留，不自动学习其他目录，也不据此接受 Neon v3。

## 来源版本差异

PRIVATE 的 49 个共享源文件与当前 Core 一致；两处 v2 兼容改动的前后 hash 在清单中单独登记。PUBLIC 沿其既有独立发布快照保留，以下四个文件与较新的 Core 不同：

- `control/postgres/access.py`
- `control/database.py`
- `control/astarter/strategy_repository.py`
- `control/postgres/pool.py`

不在运行时混合两者。各自的导出清单与对应测试才是分发包的证据；复制新 Core 文件替换 PUBLIC 任一文件需要一次新的明确导出与验证。

## 为什么仍有旧日期的基础文件

当前 Astarter 直接复用原数据库迁移链、审计、数据 fixture、Nautilus 运行器和部分合同，源码日期不因此改变。完整性要求保留这些依赖及兼容测试。

本次移出的对象是旧参考前端、其启动／浏览器工具、早期产品稿、开发过程目录和历史执行计划。它们仍可由 Git 历史追溯，不作为当前入口。原静态工具中的后端 BACKTEST、路由、live venue、Agent 工具和来源 pin 门禁仍完整保留，仅去掉已移出的 UI 分支；原 Python 秘密扫描与全部后端回归也保留。后端仍需的一份 HTTP fixture 已迁入 `services/engine/tests/fixtures/historical_http_v1.json`，原精确 hash 与三个正负例不变。

两个分发包保证其服务入口和已登记来源的闭包，不等于 Core 的任意库 API 都能在裁剪包中调用。PUBLIC 包保留了原来的部分惰性通用 PG 导出，但不包含那些非 PUBLIC 入口的实现；完整通用库在 Core 中使用，不向分发包混入新版本来凑功能。

## 接续顺序

1. 固定当前 Core／分发来源和真实权限归属，核对现有预算、有效期及未决责任。
2. 需要恢复 R3 云验收时，先补完独立空库、最小权限、独立 oracle、真实 schema-v3 pin 和兼容恢复证据。
3. 再在合成目标中验证 PRIVATE 读写、CAS、身份和预算责任，与产品前端联调。
4. 最后才按单独范围决定模型、真实来源、持续调度和生产切换；不要复用已过期或已消耗的执行 attempt。

本文件不授权或自动执行上述步骤。

## 本次仓库验证

首轮广泛 unit／contract 检查为 5,043 通过、212 跳过、15 失败，原日志保留，没有把它写成全绿。5 项 CLI 失败来自整理工作树没有本地虚拟环境路径；复用已安装依赖后，该文件 48 项通过。9 项扫描器回归在未整理的原基线也完全复现，原因是 `access.py` 已新增既有 PRIVATE research 枚举，而扫描工具仍 pin 旧文件；本次只对齐这一个公开源码 seal，固定指纹槽、允许值和负例不变。另有一项进程等待超时，原样隔离复测为 1 passed／13.43 秒，未改断言或加长十秒等待；其确切原因仍未知，保留 WATCH，不能用一次复测把间歇问题宣布关闭。
