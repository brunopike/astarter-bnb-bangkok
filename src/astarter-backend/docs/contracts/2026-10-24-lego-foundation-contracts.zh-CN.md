# Lego 基础接口映射与阶段边界

日期：2026-10-24。这是已实现接口与后续消费链的映射；DP03完整业务合同尚未完成。主规格仍为`2026-09-18-sta-30-trading-foundations-design.zh-CN.md`。S03产品策略另有项目策略卡，不能把本SMA工程基准更名为S03。

## 1. 已接受的离线边界

源候选`22b875c`已通过2648项Engine测试、明确加载严格配置的mypy和Ruff；独立审查的1项Important已用26项RED→GREEN回归修复。证据见`.goodway/lego-ai-quant/historical-input-contract-gate.md`。

| 接口 | 消费/产出 | 权限边界 |
| --- | --- | --- |
| `domain/historical_input.py` | SMA参数、风险、成本配置、数据/运行环境绑定、InputManifest.v2 | 只定义严格不可变合同 |
| `audit/historical_input.py` | 配置/input规范字节与解析、dataset派生、`validate_input_bindings` | 核对声明；不授权运行、不认证文件或数据库 |
| `catalog/historical_identity.py` | 元数据、原生品种、readback、文件清单及hash的内部一致性 | Control发布边界和v2输入共用；仍须另做真实文件重验 |
| `runner/historical_cost.py` | 原始零费率品种→运行专属费率副本及锁定原生profile | 不改源目录，不假设Node能接受该profile |

三个身份分别为完整配置envelope哈希、成本字节哈希、完整input字节哈希。配置ID/发布版本只影响input身份；名称、参数、数据、风险或成本变更影响配置内容身份。所有调用者使用公开codec，不能绕过其嵌套重验直接序列化model_copy构造的对象。

## 2. 后续接线必须完整

| 切片 | 负责模块 | 接入条件 / 状态 |
| --- | --- | --- |
| F2B2原生执行 | 独立historical runner、SMA/guard及v2报告投影 | 直接BacktestEngine检查点和SMA/guard内部组件已接受（f2ce265；Engine2692）；文件/runtime loader已接受（1715de2；Engine2709）；有限内部owner已接受（92a4efb；Engine2719）；MARKET订单v2投影也已接受（6c6dfcd；Engine2780，2项Important修复后通过）；完整内部多币种报告组件也已接受（db6ea9a；Engine2904，2项Important经反例修复，1项内部金额语法/异常类型Minor明确暂缓），外部运行接线仍待完成 |
| F2B3控制与证据 | `control/strategy_configurations.py`、`preflight.py`、`transactions.py`、`supervisor.py`、`finalizer.py`、`recovery.py`，runner输入/协议 | 文件/runtime重验内部组件已接受；显式版本分派、数据库授权/原子版本/运行绑定、退出与恢复仍未接线 |
| F2B4接口消费 | Control routes、OpenAPI/生成类型、BFF白名单与策略catalog | 新消费链完整且回归后才激活注册项；尚未接线 |
| F2C页面闭环 | 已有研究/配置/运行页面 | 选数据→配置→发布→预检→运行→原生结果与血缘；尚未接线 |
| 后续产品层 | S03编译、ABC、模拟账户、研究角色、广场与BYOK | 按项目20工作包/9基础子节点依赖推进；本切片不替代这些验收 |

旧v1解析失败不能落入v2猜测，v2也不能降级为v1。新版本必须端到端明确传递；不能先显示“可运行”再补下游校验。

## 3. 原生执行约束

- 单操作员、单品种、一次活动运行；现货CASH、NETTING、无做空/借贷/加仓。
- SMA基于可用闭bar，至少slow+1；相等关系按主规格，重复信号不得重复下单。数据结束保留真实持仓/未决订单。
- 每次意图前重新核对确认仓位、原生余额及未决占用，检查最大数量、每单名义金额与含费现金。模型不在下单热路径上。
- 主规格没有退出金额豁免或分单规则；BUY/SELL均受每单金额限制。超限退出须明确阻断并保留未平仓，不能静默改变策略。
- 当前价格检查不承诺市价成交不跳价。成交后的逐币种守恒/仓位对账失败必须使运行失败，不能手工补余额或用自写PnL冒充原生结果。
- 原生快照保留币种向量与stale/unpriced标记。PRE_INTENT不能被展示成当根成交后状态；FINAL_POST_RUN另存。

## 4. 数据用途门槛

合成数据只用于边界验证。真实市场验收同时需要来源/下载哈希与用途权限；公开可访问不等于可用于商业产品。2026-10-24已在项目`DP01-隔离验证回传.md`记录Binance Vision现行数据集条款限制，未把它扩大为对所有交易所API的判断。当前不新增下载或把旧样本技术验收冒充商业使用许可。

## 5. F2B3 配置发布与输入绑定

本阶段复用单个 ControlStore、策略草稿/版本/审计表。SQLite 增量升到4，为草稿与版本增加明确的 content_schema（StrategyConfigurationInput.v1/v2）；已有行默认v1，原始内容字节、哈希、版本和旧运行证据不改写。旧二进制必须拒绝写入版本4数据库：schema4对17张共享表的插入/更新/删除使用连接级写入版本函数校验；新工厂注册固定版本，已打开的旧二进制连接缺少函数也必须失败。维护中的事务取得写锁后再次检查版本；后续迁移必须替换精确版本守卫。这是兼容性边界，不是对恶意本机数据库操作者的安全隔离。升级失败回滚，升级竞争在锁内重新读取版本与核对结构。

- 新内部接口只接受 SmaConfigurationInputV2。草稿保存、乐观修订、同修订幂等发布、版本列表和重启读取均使用已接受的配置codec；嵌套model_copy不能绕过校验。
- v1读取明确选择v1，v2读取明确选择v2；不能根据解析失败降级猜测。草稿不能跨版本改类型。新v2版本在SQL层禁止更新和删除，版本必须与父草稿的内容类型一致。
- 发布在同一BEGIN IMMEDIATE内读取精确草稿修订、已发布Catalog.v2记录及审计，校验品种数量精度/步长，写入版本与发布审计。不存在、PREPARED、INTEGRITY_FAILED、v1或损坏目录记录不能发布新版本。重试返回已发布的同一版本且不追加审计；目录后来失效不删除既有版本。
- v2读取验证配置规范字节/哈希、ID、修订/时间及对应审计证据。读取旧版本不依赖当前草稿内容，也不声称其目录当前可执行。
- HistoricalConfigurationService用服务端ID工厂生成草稿和配置ID。build_input_candidate(configuration_id)从已保存的不可变配置加载；调用现有FixturePublisher.revalidate核验实际目录文件、原生readback与发布状态，观察当前锁定运行环境，按固定执行profile生成InputManifest.v2。完成后重读DB目录/配置，防止校验期间的状态漂移。
- 输入候选返回规范字节、哈希和版本/目录血缘；它不创建run、不签发预检、不授予运行权限。执行前的原子预检消费、单运行锁、进程监督、报告持久化/恢复与API/UI仍须后续完整接线。
- 再次修改草稿不改变已发布版本或其输入；新发布版本绑定新的内容。文件在候选创建后仍可能变化，因此后续runner必须使用已有真实文件/runtime loader再次校验。
- 本阶段仅在隔离测试临时数据库验证迁移与生命周期，不打开现有服务数据库或旧工作树runtime。不新增付费接口、LLM调用、远端操作或实盘路径。

版本读取必须将顺序号绑定到不可变发布审计的实际先后顺序，并核对真实版本行与源修订；单个版本、列表、重复发布和输入候选共用这一校验。

## 6. 保存后报告读取：已接受的内部组件

状态：读取器内部组件已接受，固定源104d8b0完整Engine 3135 passed in 561.36s (0:09:21)；两项Important已反例复现并修复。具体任务为`docs/superpowers/plans/2026-10-24-lego-historical-report-reader.md`。配置发布/输入候选组件现已通过2975项完整Engine门槛；这不替代后续运行授权与报告接线。

- 读取器接收原始report bytes、component snapshot bytes，以及调用者独立提供的run ID、原始input bytes/可信hash、绑定catalog bytes和预期原生account ID。载体本身不是权限凭证；未来Control适配器必须从不可变运行预约/封存记录构造，不能从候选报告复制期望值。
- input自身绑定配置ID/版本/内容hash、费用和原始runtime；catalog绑定品种/币种及连续整段时间线。读取时复用已有codec并重新验证嵌套对象；不能以当前机器runtime或当前catalog是否可新开运行决定历史报告身份。`account_id`当前不在InputManifestV2内，来自另行钉住的执行profile合同；不能虚构已有字段。
- 复用同一套报告事实核验函数，既供活引擎构造器使用，也供保存后读取使用。MARKET订单使用v2行codec，其他表复用既有行codec、唯一性与规范排序规则。保留同时间戳的不同账户快照，不能把排序解释为因果顺序。
- 先关闭原始fill金额语法/异常类型Minor：接受有限普通十进制，原始金额串最长128字符，拒绝分数、指数、空白、NaN/Infinity和非法除数，统一ReportSchemaError。原始producer bytes不改写，允许其合法尾零与负零。报告投影仍使用既有精确规范数值格式。相同128字符定点语法也在v2表格与快照的金额字段进入Decimal/Fraction前执行，防止短指数串膨胀成巨量输出；非金额metadata字符串不受此语法限制。
- 候选验证与封存后重验使用两个函数：候选验证重算结构/绑定/诊断并返回两个digest；重验必须同时给出此前独立持久化的report和snapshot digest。缺失可信锚点不能自动降级为候选模式。
- 每份report/snapshot最多128 MiB，JSON嵌套最多64层；在解析和递归规范化前检查界限。input/catalog沿用已有64 KiB/4 MiB合同限制。这是接收边界，不保证所有允许bar数的数据都能在该体积内输出，也不是解码内存SLA。
- 状态使用真实的`INTERNAL_REPORT_CHECK_PASSED`/`INTERNAL_REPORT_CHECK_FAILED`。结构完整的原生失败证据应保留失败状态；损坏/不规范/身份不符的字节抛出schema错误，不能伪装成已校验的失败报告。它们与Control的COMPLETED/FAILED/CANCELLED分开。
- 本切片在引擎dispose后核验已保存字节，不创建引擎。现有codec仍间接依赖锁定的Nautilus/pandas，不能宣称可在未安装依赖的环境直接运行。
- 首次接收、staging固定文件集合、版本化协议、受监督子进程、fsync/rename/DB封存和崩溃恢复在后续计划闭合。文件系统与数据库通过恢复协议衔接，不能声称跨两者存在单个原子事务。v2进入可运行队列前，所有消费者必须显式分派并具备完整能力。
- 新发布配置不使另一个既有不可变版本失效；原始随机ID继续保存。另建经济重放投影须先有独立原生验证，当前字节幂等不能被当作跨运行可重放证明。

### 6.1 最终审查修正：独立复算

保存快照的 status/failure_codes 不是一致性通过的依据。读取器从独立绑定输入取得 starting_cash，复用原生回调的现金 delta、commission 与 long/flat 仓位检查；每个检查点必须匹配按时间可成立的原始成交回调前缀，最终点必须包含所有成交。相同时间戳账户行的排序不构成因果证据。原生失败诊断保留，现金/仓位矛盾即使删除两侧诊断也不得通过；最终 positions 表还须与其成交事件及检查点仓位对应。订单原生终态、ts_last 与成交事件数量必须和 orders/fills 一致，REJECTED、DENIED、CANCELED、EXPIRED 不可互换。该修正只约束内部 v2 报告；不激活 Control/API。

## 7. v2 子进程交接与原始报告落盘

- 显式 `runner.historical_main` 入口，必填独立 input 摘要。初次实际加载建立期望，owner 再次实际加载后才构造原生引擎；两侧身份与一次构造/运行/成功 dispose 必须一致。当前 SIM 配置的独立账户期望为 `SIM-001`。
- 标准输出只包含 `RunnerStarted.v2` 和 `RunnerOutcome.v2` 两条规范 JSONL；每条最多64KiB。父进程以独立 run/input/catalog/cost/package/account 身份核对顺序和退出码。成功仅指原生组件及保存后报告校验通过，不是 Control 封存。旧 v1 协议保持独立。
- 固定保存 `reports/component-snapshot.json` 和 `reports/historical-report.json`，原始字节分别摘要，每份最多128MiB；该上限不是吞吐或延迟承诺。目录0700、文件0600，仅普通单链接文件。只创建，不覆盖；完整写入与 fsync 后以不替换的 link 发布。失败保留已完成前缀，不伪造完整集合。
- 结构有效但原生对账失败仍保存两份证据，以 FAILED 报告状态和非零退出返回。执行/证据错误不声称存在有效报告；持久化失败的候选前缀须由以后 Control 再读验。任何摘要来自本次候选都不是独立 DB 锚点。
- 此段不创建 DB 运行、不排队、不改 API。完整启用仍依赖预检预约、显式 v2 监督、封存恢复以及 API/UI 接线。总输出界限、取消/超时和进程所有权由后续监督合同负责。

## 8. 完整 Control 接入合同（内部链已验收，公共API待接）

- schema5 使用一个不可变 `runs.contract_kind`：旧行默认为 `PROBE_V1`，历史任务为 `HISTORICAL_SMA_V2`。按它选择固定输入、子进程协议与报告消费者。升级替换所有连接级写入版本守卫，旧连接不能继续写；混合版本启动和恢复不能把 v2 字节送给旧解析器。新消费链完成前只允许隔离测试夹具创建待处理 v2 行，公共调度不开放。
- 复用已实现的 `HistoricalConfigurationService.build_input_candidate`。实际目录和运行环境的昂贵复验放在写事务外；事务内重新比对不可变配置版本、目录发布记录、原始输入、成本及配置内风险摘要。READY 只预约一个 run；consume 在同一事务消费它并转 QUEUED。
- 源码复核纠正：既有 SQLite 单写事务和逐 run 进程 claim 并不等于全局单运行准入。新链须在共享 runs 上补建历史任务独占准入：v2 入队时其他类型的活动 run 必须为空；v2 处于 QUEUED/RUNNING/CANCEL_REQUESTED/CANCEL_PENDING/FINALIZING 时，阻止任何新 run 入队。保留原来的纯 v1 并行行为。不另建第二套运行锁/状态机；未知进程存续不能自动释放占用。
- 使用闭合的历史事务入口和明确幂等 scope，复用共享幂等表及事件/状态底层能力。旧 v1 命令校验器保持隔离。同键异请求冲突；同键成功响应原字节回放。过期 READY 收据仅证明当时通过，不能当作当前消费许可；重新预检必须用新键。已成功 consume 的重试返回原 QUEUED 收据，不受后来占用情况影响。
- 文件发布前先持久化经独立复验的 terminal preparation、输入/配置/目录身份和两个原始报告摘要。恢复只能用这个既有锚点核对文件；无锚点的已发布目录保留为未验证证据，不从现场自取 hash 补写成功。
- 完整验收必须走已发布配置→READY→同一 run 消费→实际受监督原生子进程→发布前锚点→最终发布→重启读取，并通过故障测试。schema 升级或隔离测试通过不等于这条链完成。

内部链固定源4034c4f09769094a75738eb0bc9ab5c566acfb62已完成上述路径，完整Engine3352项通过；审查的3项Important修复后，恢复不造anchor、公共v1取消不写v2、发布锁内重验不可修复已发布目录等边界均有回归。详细裁定和范围见`.goodway/lego-ai-quant/historical-control-chain-gate.md`。公共v2调度/HTTP和UI仍关闭，产品S03/ABC与连续PAPER仍需各自验收。
