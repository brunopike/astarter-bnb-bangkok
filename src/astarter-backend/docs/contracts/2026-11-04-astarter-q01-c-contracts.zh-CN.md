# Q01-C：版本化离线合同 v1

状态：作者离线候选，待 Codex 两路独立审查；不是运行验收、可信签发或交易许可。所有新增 DTO 固定 `scope=CONTRACT_PREFLIGHT`、`purpose=OFFLINE_FIXTURE`、`execution_authorized=false`。模块没有 runtime caller，也没有注册 exports、路由或适配器。

## 1. 范围、输入与复用

源码仅 `domain/strategy_contracts.py`；直接测试、`q01_c_registry_v1.json` 和本文件为其余三个租约文件。不修改旧源码/配置/schema/migrations；不新建 `s03_bridge.py`。基线 `6da764268baf9fd70fac7a9fcb96a650525d4402`。

输入为协作内容 v0.2 第8节、execution-design-v0.2 第1/2/6/7/12节、S03/VP 参数附录及职责第10节、design-registry-v0.2，以及 P0.5 接收评审和阶段接单记录。输入完整文件 SHA 见 TASK 验证 JSON；产品文件只读。

| 现有对象/位置 | 本次复用 | 刻意不做 |
| --- | --- | --- |
| `domain/s03_signal.py` 的 `S03Parameters`、`STRATEGY_VERSION` | 直接导入实际类、合法域、原始参数 hash 属性；不重新实现数学 | 不把 research 默认值直接塞入原对象，不改信号/指标 |
| `integrations/contracts.py` | `Identifier`、`RoleId` A01–A18、毫秒 `Timestamp` | 不借 `RoleId` 字符串声称职责完成 |
| `research_egress.py` 的 `Closed/canonical/Digest/Atoms/encode/digest_text` | exact-type、有界深拷贝与重验入口、canonical JSON hash | 不复制另一套授权、费用观察或签发器 |
| `research_gate.py` 的 `BudgetReceipt`，`research_egress.py` 的 `BudgetQuote` | 直接兼容检查旧 SIM unit/scale6/unknown 语义 | 不调用 gate，不运行 DAG/调度器/模型，不实现账本 |
| `research_delivery.py` | 沿用 PUBLIC/PRIVATE、BYOK 必须私人范围的原则及原兼容测试 | 不把 artifact/cache hash 当私人批准；不新增缓存 |
| `domain/astarter_risk.py` | 继续保留唯一 Q03 精确纯数学，并跑既有纯数学测试 | 本片无算量需求，不为凑 import 复制/包装风险数学 |
| `domain/historical_input.py` 的原 SMA 身份 | 仅保留 `SMA_LEGACY_REF/sma-cross-long-flat@v1` 引用 | 不接受 SMA 参数进入 S03/研究 profile；原 SMA API 不动 |
| 原 S03 树 `domain/s03_bridge.py` 与冻结 spec §3/SB02 | 只读九职责、私人账户、参数/manifest/费用/ABC/期限绑定要求 | 不导入其 local issuer，不复制 seal，不写原树，不跑原树测试/F5/Task4 |

依赖调用者核对：S03 参数当前用于 `runner/s03_indicators.py`；Q03 用于 `control/astarter/service.py`、`domain/astarter_simulation.py`、`integrations/q03_inputs.py`；research canonical 用于 delivery/gate。这些旧入口没有接入本模块。本次新增 public 函数只有本片测试消费。后续接线必须单独租约，不自动扩展这些 caller。

## 2. 身份、版本与冻结参数

`StrategyIdentity` 校验已知 ID、kind、rule version 的组合。18个基线和 VP 共19条不包含历史 SMA，也不把 Astarter 组合重复算作目录条目。

| 分支 | kind / version | 合同意义 |
| --- | --- | --- |
| 原 SMA | `SMA_LEGACY_REF / sma-cross-long-flat@v1` | 身份引用；不由新 `StrategySpec` 承接 |
| 原 S03 | `S03_ORIGINAL / s03-ema-rsi-long-flat@v1` | 使用现有 S03Parameters；原风险0.005、名义0.2 |
| 新离线组合引用 | `ASTARTER_COMPOSITION / q01-c-s03-astarter@v1` | **本片新建的引用版本**，不是原 S03 bridge 或已实现 Astarter 组合版本；最多 RESEARCH_ONLY |
| VP | `VP / s02-virtual-probe-limited-basket@research-v0.1` | 独立固定参数；虚拟层不入真实盈亏/资金；算法未实现 |
| 其余研究条目 | `RESEARCH / research-v0.1` | 逐 ID 固定只读参数，不能以同 version 跨 ID 复用 |

`CatalogProfile` 为 `Q01_C_PROFILE_V1`，固定来源 revision/hash、完整默认参数 hash、执行资产/域、数据需求和能力集合。生产模块只带不可变 tuple pins，不读 Projects 的绝对路径，也不读测试 JSON。fixture 保存19条 **全部346个参数默认值**，逐值对照来源检查；不是运行配置。

非 S03 只接收与 pin 精确相等的 canonical `frozen_defaults_json` 字符串，不把嵌套 dict/list 留在冻结对象内。字符串保留来源十进制拼写（例如 `0.10`）、null、布尔和集合。不同参数、未知参数、额外参数或其他 JSON 内容均不匹配；没有 eval，也不把自然语言 validation 伪装成可执行校验器。变更须以后新增明确支持的 profile/version，不能临时改 pin。

S03 fixture 原始 `notional_fraction="0.20"` 与实际源码 canonical `"0.2"` 表示同一精确比例，但**字节和输入合同不相同**。仅 fixture 的显式来源映射转换这一已知默认值；`S03Parameters(notional_fraction="0.20")` 仍拒绝。14个可编辑参数由实际类校验；`signal_ttl=5s / quote_max_age=2000ms / target_enabled=false` 是来源 profile 的固定项，不扩充原类。preflight 不是行情信号处理器，不声称执行5秒机会或完整报价验证；2秒 MARKET_WINDOW 与120秒 NEWS_HEALTH 仅是预检中的必要时间上界。

`ABCReference` 冻结策略身份、`Q01_ABC_SOURCE_REF_V1`、来源全文件 hash 和 A/B/C 引用标识：入场门槛、策略源退出、停新增与保护/对账分离。具体 ABC 条件仍在来源规则；此对象不实现退出算法，也不把通用描述覆盖原 S03 无 TP 的规定。改身份/ABC/source/费用/profile 会改变 plan hash。

`PlanRevision` hash 包含完整 spec、参数 revision、ABC、tenant/account/environment、品种与费用、数据/能力/risk/role revision、证据 manifest hashes、起止时间。`check_revision(old,new)` 对比合成前态：内容变更要求新 plan revision；spec 变更同时要求新 parameter revision（保守重新审阅）。数据库中的版本唯一性、谁有权创建 revision 由 D1 负责，不靠全局 mutable 缓存。

## 3. 19条能力、状态与缺口

共同能力 `CEX3` = `LIMIT_IOC / SELL_STOP_MARKET_GTC_BID_ASK / SELL_MARKET_IOC`。所有条目都要求 MARKET_WINDOW、NEWS_HEALTH、下表专项数据、FEE_SCHEDULE 和匹配能力证据。此处是最低**引用合同**，不是全部算法原生执行能力清单。

表中“最高离线结果”仅指完整、范围一致、有效的**合成引用**；任何所需项缺失/不合格均优先 BLOCKED。当前没有真实 issuer、接线或源证据，所有条目真实执行均未放行。

| ID | 执行域 | 能力 | 专项数据引用 | 最高离线结果 / 尚缺 |
| --- | --- | --- | --- | --- |
| S00 | BTC/USDT SPOT | CEX3 | POINT_IN_TIME_SCORES | RESEARCH_ONLY；点时评分方法/日志、完整规则未接 |
| S01 | BTC/USDT SPOT | CEX3 + LIMIT_GTC_POST_ONLY | RANGE_BARS | RESEARCH_ONLY；层级/补单/退出/原生能力 |
| S02 | BTC/USDT SPOT | CEX3 | BASKET_BARS | RESEARCH_ONLY；有限三层、成本后验证、整篮占款 |
| S03 | BTC/USDT SPOT | CEX3 | S03_CONTINUOUS_BARS | ELIGIBLE仅合同匹配；九职责引用、F5/原生闭环仍非本片许可 |
| S04 | BTC/USDT SPOT | CEX3 | CONFIRMED_PIVOTS | RESEARCH_ONLY；确认端点/中枢规则 |
| S05 | BTC/USDT SPOT | CEX3 | ORDERED_L2_TRADES | RESEARCH_ONLY；真实成本优势、L2顺序、尾延迟未证 |
| S06 | BTC/USDT SPOT | CEX3 | CONFIRMED_WAVES | RESEARCH_ONLY；确认浪型/不回画规则 |
| S07 | BTC/USDT SPOT | CEX3 | SPRING_TEST_BARS | RESEARCH_ONLY；Spring/Test/容量/退出规则 |
| S08 | BTC/USDT SPOT | CEX3 | INSIDE_BAR_STRUCTURE | RESEARCH_ONLY；母子K/结构/退出规则 |
| S09-A | WETH/USDC CHAIN | ATOMIC_ROUTE + NONCE_RECEIPT_RECONCILIATION | REGISTERED_ATOMIC_POOLS | RESEARCH_ONLY；准确池、同状态、nonce/receipt/失败gas；来源默认注册仍null |
| S09-L | WETH/USDC LP | CLMM_POSITION + WITHDRAW_RESIDUAL_INVENTORY | REGISTERED_CLMM_POSITION | RESEARCH_ONLY；池/position/ticks/两币残余/净值；来源默认仍null |
| RX01 | BTC/USDT SPOT | CEX3 | OFFICIAL_RELEASE_CALENDAR | RESEARCH_ONLY；真实官方发布/改期/子事件 |
| RX02-P | ETH/USDT SPOT | CEX3 | ORIGINAL_POSTS_HISTORY | RESEARCH_ONLY；原帖/去重/历史覆盖，不能用聚合替代 |
| RX02-A | ETH/USDT SPOT | CEX3 | AGGREGATE_ATTENTION_HISTORY | RESEARCH_ONLY；聚合方法/单位/历史窗口 |
| RX03-S | ETH/USDT SPOT | CEX3 | FINALIZED_REGISTERED_POOL_FLOW | RESEARCH_ONLY；源为eip155:1 CHAIN，执行仍SPOT；池注册/最终性 |
| RX03-B | BTC/USDT SPOT | CEX3 | NATIVE_BTC_ENTITY_HISTORY | RESEARCH_ONLY；源为原生BITCOIN CHAIN引用；不是包装BTC，标签历史仍缺 |
| RX04 | ARB/USDT SPOT | CEX3 | UNLOCK_REGISTRY_INVENTORY | RESEARCH_ONLY；仅库存防御；解锁登记/分母/目标协调，禁止据此开买/裸空 |
| RX05 | Binance BTC/USDT SPOT | CEX3 | SAME_VENUE_PERP_AND_SPOT | RESEARCH_ONLY；必须同资产/quote、USDT结算、同venue的冻结PERP对应引用，另有SPOT窗口；不是PERP执行 |
| S02-VP | BTC/USDT SPOT | CEX3 | VIRTUAL_PHYSICAL_LAYER_BARS | RESEARCH_ONLY；虚实层/跳层/共同退出/成本验证 |

`InstrumentProfile` 明确 native_id、venue、base/quote、SPOT/PERP/CHAIN/LP、chain/pool、tick/step/min_quantity/min_notional/multiplier、fee currency/rates/revision。沿 Q03 `SizingLimits` 分开最低数量与最低名义：`min_quantity` 单位固定为 base（如 0.0001 BTC），`min_notional` 币种固定为 quote（如 5 USDT），不是合约张数或费用币种。数量须正，名义可显式为零；缺任一事实预检 BLOCKED。未发布合同直接移除无单位的 `min_order`，不猜它的含义，也不提供旧字段兼容。精度/费率/最低限制是 canonical 十进制文本，不接 float/NaN/Infinity；本片不新增数量计算层。仅知道 native_id 字符串不证明真实所内身份。source_product/source_instrument_id/source_venue/source_chain 与执行品种分开核对，不能用PERP能力证据替代SPOT，或用现货补齐链/LP证明。

RX05 在本离线版本严格冻结一组对应引用：执行 `(BINANCE, SPOT, BTCUSDT, BTC, USDT)` 对应来源 `(BINANCE, PERP, BTCUSDT-PERP, BTC, USDT, USDT)`；后三项分别是 `source_base/source_quote/source_settlement`，必须明确提供并逐项匹配。两个 ID 是本片不解析的冻结引用标识，不声称已核验交易所真实 instrument registry；任何其他 opaque ID（包括 ETHUSDT-PERP）、错 base/quote/settlement/venue/product 或缺必要身份，即使重算 manifest 也先 BLOCKED，不能降为仅 adapter pending。合法完整引用最高 RESEARCH_ONLY。此限制只作用于 `SAME_VENUE_PERP_AND_SPOT` 的跨产品对应；RX03-S 的 eip155:1 链池、RX03-B 的原生 BITCOIN 及 S09 的链/LP域维持原有分域语义，不被迫提供 CEX 结算币。

## 4. 证据、权威与私人批准

**信任边界：** `EvidenceSnapshot` 的 source/content/hash/status/rights/coverage 均为引用声明，不包含原始供应商 body/header、凭据或私有账本。`SYNTHETIC_REFERENCE` 只能参加离线匹配；`BACKEND_REFERENCE_UNVERIFIED` 一律不能满足门槛。客户端自报 supported/approved/ready 字段拒绝；自行填写合法 hash 或 issuer_reference 也不获得执行权。

未来可信后台必须先验证实际来源/签名/账户权限/撤销/原生 instrument & capability/完整覆盖，再建立独立权威对象。不能把用户送来的 synthetic 标签升级成生产事实；本片没有这个 issuer、API 或 verifier。原 S03 local issuer 的 seal 和原 ns 级输入摘要不是本片引用可生成/替换的。生产控制面审批格式和转换器留后续，不承诺这两个树已互通。

公开函数 `contract_hash / preflight / check_approval / request_for / check_replay / check_revision / state_policy / budget_policy` 复用 canonical exact-type 边界：复制后重验全部嵌套字段，拒绝 subclasses、额外 model_copy 字段、非法 model_construct、嵌套 list、bool-as-int 等。对象持有 tuple/model/不可变字符串；不单靠 frozen=True。Python 中刻意 object.__setattr__ 或改 __dict__ 仍不是安全隔离机制；下一次公共入口会重新验证非法结构，合法实质变化会改变 hash 并让旧批准失配。调用者不能在检查后把可变对象转交执行器绕过消费检查，本片根本没有执行器。

每个 source 引用固定 window start/end、event/available/received、expires、rights_until、max_age、coverage 和 revision。消费 `now_ms` 由调用者显式给定，不读系统时钟；未来数据、过期/无权限/非完整覆盖/UNKNOWN/BLOCK 拒绝。source 顺序明确为该离线模型的 window_end ≤ event ≤ available ≤ received；与旧 Provenance 的 clock 定义不同，不做隐式互转。全部证据 hash 有序写入 plan manifest；只刷新外层时间不能更新源窗口。顺序变化也保守视为新内容。

`ApprovalSnapshot` 永远 PRIVATE，绑定 plan revision/hash、tenant/account/environment、risk_policy、role schema、起止期限。每项 `DutyEvidence` 都要求 PRIVATE 同 binding、plan hash、对应 role name 和 role语义版本、PASS、有效来源窗口和权限。公开研究可作为建案材料，但不能作为私人职责批准；BYOK 不能成为 PUBLIC；没有公共共享批准对象。

每项职责引用必须满足 `available_at_ms <= received_at_ms <= approval.starts_at_ms`，同时仍须在消费 now 有效。本地 received 表示当时已接收；等值接收/批准开始通过，晚 1ms 即不覆盖职责，不能因当前已读到、重算 hash 或改写时间来补历史审阅。本版没有外部先见例外或新签发系统。

`check_approval` 子入口仅有 `(S03, S03_ORIGINAL, s03-ema-rsi-long-flat@v1)` 适配器；其余合法 kind 返回 `BLOCKED/NO_REVIEW_ADAPTER`，伪造版本在 canonical 边界拒绝。组合引用即使带九项匹配职责也不能从子入口得到 ELIGIBLE；完整组合 preflight 仍最高 RESEARCH_ONLY。原版有效证据复用及 0/6/8/12 调用预算不变。

### 九职责映射（`Q01_S03_NINE_DUTIES_REF_V1`）

职责释义来自 execution-design-v0.2 §10；九项集合来自原 S03 冻结 bridge/spec。本版本仅允许 `SIMULATED_PRIVATE_REVIEW_REF`，所有其他方法（包括 role 字符串、模型结论、未建适配器的确定性工具）拒绝，不能默认算覆盖。

| role | 语义 | 本版必须引用的审阅范围 |
| --- | --- | --- |
| A01 | 市场环境 | 同计划的数据/环境假设 |
| A02 | 多周期趋势 | 同profile的周期与趋势假设 |
| A07 | 策略规则 | 同策略/全部参数/规则版本 |
| A10 | 反证 | 同费用/来源/未来泄漏/尾损假设 |
| A12 | ABC | 同冻结ABC引用及失效路径 |
| A14 | 组合敞口 | 同tenant/account/risk-policy依赖 |
| A15 | 资本保护 | 同风险版本和压力缺口 |
| A16 | 执行质量 | 同品种/费用/能力profile |
| A13 | 决策整合 | 同plan revision/hash的整合结论 |

Q01 的每项输入 hash 保守绑定**整份 plan**，不是声称复制了原 bridge 的 role-specific hash 算法。没有实现从原 S03 review 转换到本对象，不能据此削减原门槛。仍在有效期、范围和版本完全相同的引用可复用，不要求9次新LLM。研究调用预算只允许0/6/8/12，既不是职责集合也不是实际调用统计；6/8/12次缺任意职责仍BLOCKED。A03/04/05/06/08/09/11/17/18保持 RoleId 支持及按需研究定位，不自动加入 S03 覆盖。逐行情/订单/保护快路径 LLM=0。

## 5. 状态和预算单位

| 状态域 | 示例 | 含义与禁止推论 |
| --- | --- | --- |
| 适配 | ELIGIBLE / RESEARCH_ONLY / BLOCKED | 只表示离线引用匹配；ELIGIBLE≠激活 |
| 生命周期 | DRAFT / PREFLIGHT / REVIEWED_REFERENCE / ACTIVE_REFERENCE / PAUSED / EXPIRED | 引用状态，不是持久运行状态机 |
| 订单 | NONE / PENDING / ACK / PARTIAL / FILLED / CANCELLED / UNKNOWN | ACK≠fill；UNKNOWN不释放 |
| 保护 | NOT_REQUIRED / PENDING / SUFFICIENT_REFERENCE / INSUFFICIENT / UNKNOWN | 单存在≠足量；引用不是原生证明 |
| 对账 | NOT_STARTED / PENDING / MATCHED_REFERENCE / MISMATCH / UNKNOWN | 不从订单终态推出对账已结清 |

`state_policy` 只返回阻断/保留检查原则；`new_risk_blocked=false` 仅表示此状态投影未发现阻断，不是新风险许可。所有输出 `risk_release_allowed=false`，不实现任何资金释放。UNKNOWN/不足保护不得被 Credits/Key 状态解除；合法退出和对账仍需走原权威流程，非绕过其风控。

该单 plan 状态投影将 `PENDING/ACK/PARTIAL/UNKNOWN` 都视为阻断新增风险；ACK 只是确认收到，不是终态，即使 ACTIVE_REFERENCE、无需保护且引用对账匹配也不能解除阻断。`preserve_protection` 与 `allow_exit_reconciliation_checks` 仍恒 true；不扩展为全账户订单引擎。

| 域 | unit / version / precision | 限制 |
| --- | --- | --- |
| 旧模拟模型预算 | SIM_MODEL_CREDIT_V1，scale=6，精确非负atoms | 不改旧 quote/receipt，不改解释 |
| 供应商责任 | USD / points / CU；Q01_SUPPLIER_METER_ATOMS_V1；provider + meter + meter_revision + scale(0..18) | 不提供费率；meter版本不同不换算；未知 cost_atoms=null |
| 客户服务积分 | ASTARTER_CREDITS；Q01_CUSTOMER_CREDIT_ATOMS_V1；scale=6 精确分项atoms | 只是本片独立数值表示，不是批准的商业报价/结算格式，不做整job收费取整 |

三类字段和对象不可互换，精度相同不意味着1:1；没有换算或收费函数。金额用整数atoms（沿旧有界 Atoms），拒绝float、非有限、数字字符串和bool。交易资金不在这些对象中。

`BudgetSnapshot` 是单资源payer的合成视图；BYOK该资源客户分必须0，但供应商成本仍可未知。customer RELEASED_REFERENCE 不改变 supplier UNKNOWN_PENDING_RECONCILE；已知费用只是 OBSERVED_REFERENCE，非发票。`budget_policy` 不改变payer，不调用/收费/释放账本，transaction_actions恒空。新Key失效、限额或未知责任阻断新研究；automatic_charged_retry_allowed恒false（即使责任字段写DECLARED_REFERENCE也未有可信issuer）。不撤保护，不拦合法退出/对账检查。P0.5补偿、费率、支付、退款和收款全部未实现。

## 6. 幂等、错误与验证界限

`request_for(key, PreflightInput)` 从实际闭合payload生成摘要；`check_replay(previous,current)` 接显式合成前态：无同key为NEW，同key同hash为REPLAY，同key异hash抛 REQUEST_PAYLOAD_CONFLICT。手工 Request 的摘要只是未验引用，推荐用 request_for；消费仍需重新 preflight(now)，不能因REPLAY跳过过期检查。没有持久索引、原子事务、跨进程幂等或全局缓存。

结构/类型错误通过 ValueError（包含原有 ResearchRejected 的 INVALID_INPUT 边界）拒绝；不回显输入。业务预检返回 reasons、missing_capabilities、missing_roles：主要有 INSTRUMENT_MISSING、INSTRUMENT_IDENTITY_MISMATCH、INSTRUMENT_OR_FEES_MISSING、EVIDENCE_MANIFEST_MISMATCH、DATA/CAPABILITY/FEES_EVIDENCE_MISSING_OR_INVALID、SOURCE_STALE、PLAN_EXPIRED、PRIVATE_APPROVAL_REFERENCE_MISSING、APPROVAL_BINDING_MISMATCH、APPROVAL_OR_PLAN_EXPIRED、INVALID_DUTY_EVIDENCE、REQUIRED_DUTIES_MISSING、NO_REVIEW_ADAPTER。缺项优先BLOCKED；研究状态不会掩盖它们。

真实语义RED为可导入 skeleton 对同请求误返NEW，原断言保持不删。GREEN覆盖19条/346默认值、S03合法非默认及非法参数、版本/账户/环境/角色/权限/期限、九职责缺项与0/6/8/12预算、来源域、嵌套伪造、单位、UNKNOWN、无交易动作、重放冲突。兼容检查只跑数据树既有 S03参数、Q03纯数学、research egress/delivery；另在直接测试构造旧 BudgetQuote/BudgetReceipt 验 scale6。没有跑原S03树或整个Engine。

禁网/零IO证据范围：直接测试在构造内存fixture后封锁 open/io.open/os.open、socket/socket.getaddrinfo/create_connection、sqlite3.connect、subprocess.Popen 和 time.time，再调用公开函数。它证明这些调用路径未触发所拦Python入口，不是OS沙箱、系统调用审计或进口依赖零IO证明。pytest导入、读取明确合成fixture、写TASK日志及类型/lint工具本身有本地文件IO；缓存/bytecode禁用。不访问供应商API/DNS/端口，不读取原始凭据/env/供应商body/header或私有DB。

第一轮验证保留在 TASK/q01-c-20261104-verification.json，不覆盖。本轮五项审查窄修先在 853c68da 原生产模块上固定公开入口语义 RED，再添加边界并验证 GREEN；命令、退出码、日志hash、实际源/测试/文档及输入hash冻结于新增 TASK/q01-c-20261104-reviewfix1-verification.json，不在本文件写自引用hash。原152测试保留，只有合法 fixture 随新合同补齐最低限制与 RX05 对应身份，不删除或放宽旧断言。

## 7. 明确未实现及交接

未实现：D1/D2/数据库迁移/原子账本/持久版本与权限、可信issuer/验签/撤销、调度器、HTTP路由、原生执行接线、支付/费率计算、F5/Task4、真实长测、全策略算法与交易执行。本片没有租约外生产修改需求；若未来调用者需要上述能力，必须由 Codex 列入独立工作包。

作者离线通过不等于验收。第一轮两路只读审查已 REQUEST CHANGES，本轮只修其五项合同问题；Codex 应对新固定候选分别做（1）合同/产品/冻结S03一致性与authority边界；（2）实现/负例/真实验证证据与租约差异的 delta 复核。作者自行执行测试，不委托审查者代跑自己的检查。本轮不启动任何其他agent或模型，不自行声称 delta 独立审查通过。
