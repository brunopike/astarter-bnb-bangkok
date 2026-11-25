# S03 有限原生模拟桥接合同

版本 0.2，2026-10-25。基线 `807443ae600b2a8fdf0c98217f8cfd15834af2d6`；Engine 与已验收 `ae1d186` 相同，schema 6。首轮2项HIGH及2项MEDIUM均已由两路设计窄复核关闭；CODE/SPEC APPROVE，ARCHITECTURE CLEAR。

本文件是已审阅、可实施的设计合同，不是能力通过声明。产品依据：`/Users/mac/Documents/AI Space/Projects/交易大法/docs/product/S03_策略卡与ABC_v0.1.md` v0.1.1。用户已授权主会话接续开发、普通决策及阶段 review；下面的接线选择由 Codex 作出。仅本地、合成数据、有限原生模拟；不启用真实 API、模型、资金、公开路由或连续 PAPER。整产品目标及其后续门槛不缩减。

## 1. 结果与选择

交付一条真实可追踪链：不可变 S03 参数与数据 → 原生指标 → 机会 → 私人模拟方案/激活校验 → 同一 Control 事务下 Q03 仓位和预留 → Nautilus LIMIT IOC → 原生保护 → C/B/A 唯一退出 → 原生成交/费用/账本 → 对账、冷却与复盘证据。

采用现有 `S03SignalStream`、`AstarterControl`、`NativeFactsSource` 和 Nautilus 引擎。新增 S03 状态协调和准入；不再建现金账本、不复制指标解释器、不手算成交。单策略、单内部用户、单群组、单 SIM 账户。

考虑过直接把 signal 交给既有 `activate/reserve`：它缺私人授权、动态价格、独占账户、时限和 ABC，不能满足产品合同。另建 S03 独立执行器会复制账本和卖单所有权。选择在现有 Control 事务和唯一原生订单作者上扩展必要接口，保留旧有限 BTC 场景语义。

完成有限桥接不等于生产激活、18 角色运行、历史收益回测、引擎进程恢复或持续 PAPER。所有这些继续列为未完成。

## 2. 当前代码事实

- `domain/s03_signal.py`：参数、指标事实、机会身份；结果明确 `MARKET_SIGNAL_ONLY`，没有交易权限。
- `runner/s03_indicators.py`：原生 EMA/Wilder RSI/ATR、连续预热、源版本、因果前缀、close+5s。恢复只能用相同种子和原始可用时间重放。
- `control/astarter/service.py`：原生来源验证、账户 CAS、唯一机会、含费 Q03、七范围预算、持久意图、订单 fence、保护/撤单/退出和锁盈去重。现有 activate 是有限组件绑定，不是私人 Agent 评审或24h授权。
- `domain/astarter_simulation.py`：当前价格可传入 policy，但账户硬上限为风险25/名义1000，staged风险比例0.0025；旧示例风险5。不得把旧 `.00368 BTC` 结果叫做 S03。
- `runner/astarter_facts.py`：原生账户/成交是权威；quote_time_ns 目前取 ts_init，尚缺分离的 source_event_time。新 source 只能绑定空的真实原生 cache，随机 venue_session；不能用于伪造进程恢复。
- 当前 `prepare_exit` 只限制同tick重复，没有 S03 的250ms/3次/通用1s期限；STOP恢复也不能直接重置旧 fill 的保护期限。

## 3. 不可变身份与可信来源

新增闭合类型 `S03BridgePlan`，冻结：策略身份、全部参数及hash、数据revision/seed、映射/能力profile版本、账户/群组身份、审批证据版本、ABC规则版本、开始/到期时间、成本和风险叠加规则。作用域固定 `FINITE_S03_NATIVE_SIMULATION`、`real_trading_connected=false`。

计划hash不是授权。增加内部 `S03SimulationInputSource`：只从本地受控合成场景构造，绑定完整数据manifest和原生session；重算参数hash、指标/前缀、机会身份及所有有效时间。Control不接受调用者填入的ready/approved/quantity/equity/allow_trade标量作为事实。来源对象必须验证当前session、序号及封存内容，不能仅凭dataclass类型或自报摘要。

首段评审是 **SIMULATED_REVIEW** 测试证据：明确九职责 A01/A02/A07/A10/A12/A14/A15/A16/A13、各自输入hash、作用域、结果和有效期；缺项/反证BLOCK/私人账户不匹配均拒绝。由受控场景的服务端构造入口签发，仅用于测试确定性激活合同，不声称真实Agent或用户完成评审。所有报告保留该标签。后续生产签发方单独实现，本次没有公开签发接口。

计划审批绑定账户、群组、参数、来源、费用能力、风险上限和ABC版本；任何实质变更产生新版本并使相关审批失效。沿用开发协作稿第16节参数化RunBinding：审批的是固定公式/额度/版本/期限，入场数量在已批准上限内按当前Q/C确定性重算，每笔交易不调用模型。实际数量及采用的Q/C随意图冻结；扩大额度或改规则必须重审。先bind私人账户，再审阅，再显式模拟激活。

激活必须原子取得账户独占权；账户已有未终态意图、未知订单或非零库存则拒绝。运行持有独占权期间，既有通用 Astarter 入口和别的S03实例也不能并发新增风险。只在全部订单终结、对账归零且退出状态结清后释放；租约过期或进程中断不自动释放未知占用。旧BTC独立场景无S03租约时行为保持。

## 4. 原生品种与费用合同

显式映射 `S03 BTCUSDT.SIM` → `BTC/USDT.SIM`，只用于本地合成 profile `S03_SIM_BTC_QUOTE_V1`。映射记录base=BTC、quote=USDT、venue=SIM、account=SIM-001、tick=.01、step=.00001、quote_unit=.00000001、maker/taker=.001；必须逐项匹配实际原生CurrencyPair与锁定 Nautilus 2.0.0rc3/引擎配置。不能去斜线猜身份，不能用T2 Binance fixture的tick=.1/unit=.000001作为该profile证据。

原生最小数量为step，原生min_notional未设置；Astarter新买入额外内部最低名义5 USDT保留。退出使用实际原生可卖规则，不能把入场内部5 USDT门槛误套到减少风险。分拆费界须验证非零fill≥step、quote扣费、无固定费、费用舍入及累计上界。实际fill违规即完整性锁，不补账。

能力名单只包含已固定原生配置并有测试证明的 LIMIT IOC、SELL STOP_MARKET/GTC/BID_ASK、SELL MARKET/IOC。版本、币种、精度或配置不匹配，拒绝激活。测试报告和运行报告分别保存能力profile及instrument hash；一个字符串“verified”不是证明。

首个运行采用显式 **闭合bar分析 + 合成QuoteTick执行**：bar只进入指标和事件协调器，`bar_execution=false`；撮合只读取通过入口资格检查的QuoteTick。不会把信号bar已发生的high/low重新用于新订单。每条bar原始close/init/available时间都保存。测试输入明确生成quote在T、bar可用在T+1ns的两个事件，要求quote先入cache，再处理bar、准入/提交和原生回调；这1ns是合成输入的时间声明，不是改写实际历史时间。不得仅依赖相同timestamp的未证实容器顺序。新单可以用提交时的新鲜合成盘口，报告声明零原生插入延迟是假设。锁定wheel只有Rust扩展和stub，没有本地engine.pyx；排序及timer/回调先后必须以本次原生trace证明，失败则修正调度，不拿最新在线文档替代。单纯OHLC撮合和连续实时模式留给后续。

**原生撮合前的feed gate是强制入口。** 所有原始quote在进入BacktestEngine的任何add_data/流式输入前，按声明的received/available时刻验证source/received双龄、500ms偏移、合法价格/数量及严格源水位线；保留源事件时间，不把迟到tick改成新tick。被拒绝quote不进入原生cache或撮合，因此不能触发已存在STOP；在其原到达时刻派发可审计的输入健康失败事件并锁新风险，时间仍可由原生timer推进。raw输入manifest与accepted/rejected记录均保存，不静默删除负例。后端reserve/claim还要复验资格，入口过滤不能替代最终授权。

## 5. 原子准入与动态预算

机会键仍由策略版本、参数hash、S03 instrument、bar_close、UPWARD_RSI_CROSS确定；source revision/prefix属于不可变请求内容。相同机会不同内容冲突，不借改source生成重复交易。已预留重试读取原收据，不重新扣预算；内容冲突、同账户别的活跃意图不能新增。

`S03BridgeControl.reserve_signal(run_id, signal_id, expected_epoch, expected_sequence, fence)` 在 **一个既有Control的BEGIN IMMEDIATE事务** 内：

1. 重读run/plan/审批/激活、账户独占权、风险锁、最新可信bar/quote/news和native来源；验证不可变hash和全部期限。
2. 使用可信源的S03观察重算机会与stop；源对象或caller的“market_match”不得跳过重算。不存在完整连续预热或真实新穿越时拒绝。
3. 由原生快照计算 `gross_equity = quote_total + base_total*bid`，`tradable_equity = gross_equity - locked_reserve`；不得使用调用者现金、候选数量或第二套权益。
4. cap=floor_tick(reference*1.002)，stop=floor_tick(signal_close-stop_atr*ATR)，stress=stop*.998。离线reference为signal_close，要求cap≥新鲜ask>stop>0。
5. 风险上限取 `min(gross_equity*p.risk_fraction, tradable_equity*.0025, 25)` 再与既有七范围余额相交；名义上限 `min(gross_equity*p.notional_fraction,1000)`。stage=1、account_multiplier=1，全部实际采用值入收据。0.5%/20%只代表S03基准，不能放宽Astarter。
6. 复用既有 `risk.size_spot` 和费用上界；可用现金=`max(0,quote_total-existing_cash_holds-locked_reserve)`。本意图动态价格profile、Q/C、审批身份及结果一并持久化；不先提交临时binding再在第二事务扣钱。
7. 复用Astarter意图/订单/预留表；一个账户/机会只能产生一个ENTRY。提交前claim再次检查新风险资格；撤销/过期/新锁后未发送的订单只能本地取消。已claim但发送未知不重发，先对账。

实现可以把既有reserve事务体提为私有 `_reserve_locked` 供两个入口复用，禁止嵌套事务或复制仓位算法。S03动态binding须有run/机会归属，通用入口不得绕过专属校验。金额用当前exact Fraction/Decimal约定，原生指标float经原有decimal桥接，不把货币运算改成float。

## 6. 时间、输入与最终动作资格

- quote保留source_event/received/init/可信序号。source与received龄都≤2s；未来最多500ms，负龄按0但不延长期限。迟到/重复不能刷新健康。当前Astarter更短冻结TTL也必须满足；相等边界由各自原合同决定（Astarter当前age≥TTL拒绝，组合从严）。
- 新闻健康source/received龄都≤120s；严重新闻事件是独立持久锁，健康心跳不能解除事件。输入全为标注的合成观察，不接真实新闻。
- 机会绝对截止close+5s，等于截止拒绝；不因模型结束、重新报价、元数据缓存或恢复改时间。
- 运行最多激活后24h，等于截止停止新风险；已持仓只管理退出，不强制伪造平仓。
- 运行时市场时钟使用原生事件ns；进程存活/数据库读取龄使用现有单调/墙钟守卫，不能混用现实日期判断历史bar过期。恢复保留原时间和水位线。
- ENTRY claim重查plan/授权/quote/news/账户/日损/机会期限；STOP和EXIT不受新闻健康/撤销授权阻挡，但仍须可信原生库存与有效报价。新闻失效不能撤掉既有STOP。已知NATIVE_INTEGRITY/RECONCILE_REQUIRED保持accepted STOP及占用。
- 没有新行情时也要由原生clock timer触发保护/订单1s、激活到期和输入陈旧检查；不依赖下一根bar或下一条quote才发现超时。
- 精确1s接受边界沿用既有 `now > deadline` 失败规则：原生明确结果时间≤deadline有效，UNKNOWN判定在deadline+1ns执行；同刻已消费的原生终态先于UNKNOWN锁。250ms与机会5s沿用各自等号规则，不混成通用TTL。测试保存timer/回调序，不通过改日志时间制造通过。

## 7. 持久C/B/A状态与唯一退出

S03消费每根闭合bar的 `S03SignalObservation`，不能只订阅偶发入场signal，否则会漏掉EMA反转和RSI失败。保存运行状态、原因集合、bar水位线、首次fill时间、低RSI计数、hold边界数、归零时间/冷却计数、每日基准、激活epoch及退出目标。这里只存风险/生命周期事实；现金、库存、成交和锁盈仍只有Astarter原账本。

`ready=false`、`gap_reset=true`、源/连续性不可信时，当前观察中的EMA/RSI布尔值均是 **UNKNOWN**，不能把重置种子的EMA相等当“趋势反转”，也不能累加RSI失败。它们只增加数据暂停原因、保留已有STOP、重做预热。此前已经可信且持久化的强制退出原因仍保留；已到的hold时间也不因指标UNKNOWN延期，但新的退出提交仍须可信库存和报价。观察 `expired=true` 只表明**入场机会**已过5s，不直接等于指标未ready；持仓事实是否可用还须通过原始bar可用时间/水位线及数据连续性检查，不能用迟到旧观察替换当前状态。

`C > B > A`，UNKNOWN绝不等于false。C再分确定退出与暂停：

| 原因 | 行为 |
| --- | --- |
| 原生STOP、趋势反转、日损、人工紧急停止、保护失败 | 合并到同一零库存退出目标，停止新买入；按可信状态取消ENTRY/保护并退出 |
| quote/news不健康、bar缺口、时钟/来源/订单/账户未知、恢复中 | 停新风险；保留有效STOP和预留。只取消可证的剩余ENTRY，不为“暂停”取消STOP；先恢复事实 |
| 严重新闻事件 | 持久新闻锁，默认停新风险并保留保护；不能从一段新闻文本临场变为全卖 |
| RSI低于fail连续2根或持仓达到参数边界 | B退出；与C同时发生按C；原因集合保留，不产生两张卖单 |
| 无上述原因 | A；有仓维持原数量/固定stop，无仓且新机会有效才入场 |

hold从首次BUY fill以后第一个 **严格晚于首次fill时间** 的5m收盘边界开始，补成交不重置。缺bar时按已过去的时间边界判断最长持仓，但不假造RSI；未知行情则暂停新的退出提交。两根RSI仅计持仓后连续闭合且有效的bar，恢复≥fail归零，gap清空计数并触发来源锁。

归零以原生库存=0、所有订单明确终态和现金/费用对账完成为准；无成交机会不得伪造卖出/盈利。冷却只计 `bar_open≥最后归零时间` 的完整闭合bar，满参数根以后必须出现新的穿越，不补做冷却/锁期间机会。同一bar不会先解除锁再补用此前禁止的机会。

每次实际库存增加后，调用同一订单作者补齐STOP；价格冻结于信号stop，不能移远、加仓或增加未定义止盈。保护接受截止=对应首次未覆盖fill时间+1s，重启不能刷新。已知异常成交价≤stop走C；异常价格/账户未知不编造可卖量。

主动退出先汇总原因，持久记录取消意图，再等原生取消终态和最新库存，才生成MARKET IOC。STOP在取消期间成交则仅卖剩余。合法取消之后突发完整性故障可能留下未保护库存，必须如实显示RECONCILIATION_REQUIRED；不能宣称原子撤换或全程保护。

每个退出目标最多3次已claim的主动EXIT（首次+2次）；未知已claim按一次可能已发送保留，不能借进程重启重置次数。相邻claim至少250ms，前单必须终态且已对账，重新读取未预留可卖量。ENTRY/EXIT提交或cancel等待超过1s无明确状态则锁对账；已正常ACCEPTED的长期GTC STOP不因存活1s被判未知。

3次仍有可卖残余→持久EXIT_BLOCKED，确认无任何在途卖单后允许**一次明确的残余保护恢复计划**：使用原固定stop、原实际残余量、独立恢复计划持久时间+1s接受期限；不改旧fill的首次保护时间、不清PROTECTION_FAILED/EXIT_BLOCKED锁。普通prepare_protection不能用该路径刷新旧deadline。恢复失败/报价不可信/原stop已穿越均显式记录未保护库存并保持锁，不能再次无限market重试。dust保留原生账本并锁新风险，不四舍五入归零。

## 8. 风险原因恢复与跨日

普通止损/趋势/B退出对账归零后执行冷却，不强制重新激活；原授权仍须有效。quote/时钟锁要2个递增且合格的新quote、账户和保护一致才能自动解除。新闻来源锁要2个间隔≥5s的新健康观察且事件连续性完整；严重事件锁需要核验解除、新私人评审与显式再激活。

bar缺口/修订需相同可信版本或显式新版本的连续窗口，重新满足原warmup；已发生的交易不重写。人工紧停、日损、保护失败、EXIT_BLOCKED、恢复/账户未知都是持久锁，逐原因修复/对账并显式再激活；解除一因不清其他。激活到期/普通停用只管理退出。

UTC日基准来自原生现金+有效bid库存；首次中途创建用真实初始时点并标注部分日。有限场景在UTC边界提供可验证native snapshot以建立下一日基准；缺该基准不能拿稍后的当前净值重置，锁新风险并显示DAY_BASELINE_MISSING。损失≥2%锁存；跨日不自动清除旧日损。Astarter既有累计七范围/锁盈限制不因S03跨日被重置，叠加从严。S03日基准是风险度量，不新增余额或可花现金。

恢复分两种证据：本段验证**同一仍活着的原生venue session内Control重开**、持久epoch/fence和原机会/计数/退出目标回读。真正原生进程丢失后，不导入报告CSV冒充活的cache，不构造新source续用旧session；状态RECONCILIATION_REQUIRED，已有未知占用不释放。跨进程原生持久恢复属于DP14/15后续，不能标为本段通过。

**事实与S03生命周期同事务推进。** 每个可信native/bar/news/timer事件的去重身份、原生账本观察、S03首次fill/归零/计数/原因/退出目标、数据水位线和审计必须在同一Control事务提交。不能先独立 `AstarterControl.observe()` 提交再在另一事务更新S03；可提取锁内observe逻辑复用。source错误时保存安全的错误类别并锁存原因，保留最后可信native事实，不把无效观察写成新健康状态。崩溃前未提交可原样重放，已提交同事件幂等，重复内容冲突不能跳过。实际native send仍在持久claim提交后，跨DB/原生cache不宣称exactly-once。

底层 `RECONCILE_REQUIRED` 的“原生当前快照已对账”与S03的“恢复后须重新激活”是不同权限。现有observe可能自动清底层暂态锁；它绝不能删除S03持久原因 `RECOVERY_REACTIVATION_REQUIRED`/日损/保护失败等。新风险门禁检查两层原因并集。重新激活须逐原因证据与新批准，健康快照不能冒充用户再激活。

**固定owner/fence。** S03 controller在显式创建或可信takeover时取得不可冒领的owner/session token及fence，日常account读不更新所持权限。所有S03变更（包括observe、计数、reserve、claim、cancel、exit、settle）验证该owner及epoch；旧实例在新controller接管后只读。共享原生driver不能沿用“每次account()取最新fence”来升级旧owner。read-only状态查询不返回可接管凭证；takeover通过同session可信宿主入口原子提升fence并保留全部在途事实。

## 9. 数据结构与文件归属

新增 schema7，仅在新建测试DB及复制的迁移fixture验证；不打开用户旧DB。迁移包括精确版本fence、不可变计划/评审/映射出处、run账户独占、源事件去重、每机会归属、生命周期和审计。用现有ControlStore/连接校验；schema6已开连接全部旧写入口必须被fence，迁移失败原子回退。经济事实不复制到新表。

建议文件：`domain/s03_bridge.py`（闭合计划/状态/纯规则），`control/s03_bridge.py`（事务与持久生命周期），`runner/s03_bridge_source.py`（受控场景/身份/证据封存），`runner/s03_simulation.py`（现有原生路径接线）。必要最小改动在 `control/astarter/service.py`、`domain/astarter_simulation.py`、`runner/astarter_facts.py`、`runner/astarter_simulation.py`、`control/database.py` 和新增迁移。现有订单发送/保护逻辑提取仅限两个runner共用，不复制另一套订单作者；方法拆分以实际实现为准，禁止无关重构。

禁止修改Q03算法、旧T2 fixture、HTTP/BFF/Web/OpenAPI、依赖版本、T3研究后台、真实API或用户数据库。旧 `SimulationPolicy` 的canonical bytes必须兼容，不通过加默认字段改变旧绑定重编码；S03新信息进入独立闭合计划。scanner/能力库存如需新增注册由主会话持有文件权；不得扩大扫描豁免。作者在主会话固定源的新隔离树实现，旧9a作者树保留。主树只由Codex集成。

## 10. 有限桥接验收矩阵

| 组 | 可证伪结果与证据 |
| --- | --- |
| SB01 来源/参数 | 非默认参数、假signal/假hash/换revision/乱序/重复/源封存修改拒绝；从原生指标得出的实际新穿越触发，不注入market_match=true |
| SB02 授权/独占 | 缺九职责/反证BLOCK/PRIVATE账户错/过期/篡改规则拒绝；同账户S03与通用Astarter竞争只有合法owner；改数量上限重审；试图用通用reserve绕过失败 |
| SB03 预算/精度 | cap/stop/stress动态；基准50/2000收紧为≤25/1000且有原生证据；更小参数继续收紧；多次非零step fill、费用上界、105/105.105缺陷由对账锁拦截 |
| SB04 时钟/门槛 | close+5s等号、双quote龄、未来500ms边界、新闻120s/锁、24h、无新quote定时超时；旧报价新接收不续命；claim前失效拒绝 |
| SB05 IOC与保护 | 无成交/部分成交/已CANCELED但有库存/原生拒绝/未知；从actual fill到STOP接受1s及超时；bid触发而非last；不回用信号bar极值 |
| SB06 ABC与退出 | C+B同时、RSI两根、hold36与非默认24、cancel竞态、报价失效保留STOP；EXIT第2/3次≥250ms，第4次拒绝，1s未知拒绝重发 |
| SB07 残余与冷却 | 3次后EXIT_BLOCKED并尝试一次残余保护；失败如实未保护；dust不归零；补成交不延长hold；完整3/4bar冷却及必须新cross |
| SB08 锁与恢复 | 日损=2%、跨日无自动解锁/缺基准、暂停/到期、2quote和2news恢复、事件锁独立；同session重开不清次数/期限/占用，旧fence不能写；新session不能冒充恢复 |
| SB09 数据库/守恒 | schema6→7 fixture、旧连接拒写、新源拒旧误用；重复/alias结算锁盈不增加；所有cash/base/fees来自原生，未知保留占用 |
| SB10 完整旅程 | 至少1条真实指标产生机会并原生完成的合成BTC路径，逐事件trace+orders/fills/positions/account+DB审计；同时保留未平仓/失败样本，不强制美化结束 |
| SB11 边界/性能 | 热路径模型调用严格0；固定主机测P50/P95/max（含Control事务，不把整段预热混入），P95≤200ms为待测目标，失败就记录并修复；不宣称1000用户容量 |

首轮复核补充反例归入上述组：SB01/06用持仓中gap导致EMA重置相等证明只暂停、不撤STOP；SB04/05用迟到旧bid低于stop证明feed gate拦截后原生STOP没有被触发；SB08/09在native observe与生命周期提交边界故障证明首次fill/RSI/归零水位原子、不因健康快照清再激活锁；SB08让两个controller共存，旧实例即使读到新account fence也不能写。SB05/06另验证1s同刻回报及deadline+1ns UNKNOWN判定。

全量Engine与既有22场景回归在最终固定候选执行；独立代码/架构两路审查、修复复验通过后才能选择性集成。产品S03-T01–14逐项映射实际证据；其中连续PAPER、真实评审/新闻、原生跨进程恢复、用户图编译/页面/收益表现仍清楚标未通过，不用有限桥接替代。

## 11. 实施与回退

先审本合同，再发精确租约。实现按“准入/持久状态 → 唯一退出/计时 → 原生场景/故障证据”提交；每步RED→GREEN与相关检查，末尾固定源全量一次。发生具体共享回归才扩大检查，不机械每步跑全量。

回退是停用新的有限CLI入口并保留新测试DB/证据，原主树验收提交可重新检出；不对任何真实数据库降级、删除记录或恢复假余额。无部署、无远端推送、无API购买。

## 12. 设计复核证据

两路独立复核的正文对象为0.2-draft，SHA256 `3c39c389ad2c072f491d2169c4f8c94e16c6620d8c7fcd1ed8457b336f74ec46`；冻结版仅更新状态说明并追加本节，§1–11的条款保持该复核版本。

- `/Users/mac/Documents/AI Space/Developer/交易大法/任务/01a15fe7_Lego原生能力验证/s03-bridge-spec-review-20261025.md`：原2 HIGH，REQUEST CHANGES。
- 同目录 `s03-bridge-spec-fix-verification-20261025.md`：2项CLOSED，OPEN 0，APPROVE。
- 同目录 `s03-bridge-architecture-review-20261025.md`：原2 MEDIUM，WATCH。
- 同目录 `s03-bridge-architecture-fix-verification-20261025.md`：2项CLOSED，CLEAR。

审查只验证设计及与当前源码的接缝，没有运行引擎或测试。代码实现、时序、费用、恢复、性能和集成需按实施计划另行验收。
