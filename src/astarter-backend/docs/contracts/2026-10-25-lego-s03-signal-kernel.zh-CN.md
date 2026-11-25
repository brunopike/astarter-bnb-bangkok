# S03 原生指标与确定性机会内核

日期：2026-10-25。状态：实施规格；本组件尚未实现。业务依据为项目 `docs/product/S03_策略卡与ABC_v0.1.md` v0.1.1，主会话已获持续本地开发与阶段决策授权。

## 1. 本段目标与接续

把已定 S03 的 EMA/RSI/ATR、闭合时间与机会条件落成一个可重放内核，供之后同一原生执行链消费。旧工程 SMA 身份与路径保留。交易系统最终仍须接齐 AI 评审/积木编译、私人激活、Q03预算、Astarter状态层、原生订单保护、回放和界面；本段仅交付其中明确可复用的信号合同。

复用锁定 `nautilus_trader==2.0.0rc3` 的原生指标，不另写 EMA/RSI/ATR 公式。复用现有 Python/Pydantic/pytest 依赖；不新增安装。新模块独立于 Data/Model T1 和 Astarter schema6 的写集。无 API、模型、网络、数据库或订单调用。

## 2. 参数合同

新增 `domain/s03_signal.py`：冻结、strict、extra=forbid 的 `S03Parameters`，字段和默认值完整对应策略卡第2节的14个参数。整数拒绝 bool/float；十进制参数为最多64字符的规范非负字符串，无指数、空白、正号、前导零或无意义小数尾零。阈值比较用精确解析值；不经 float 校验金额/风险比例。

| 字段 | 默认 | 有效域 |
| --- | --- | --- |
| ema_fast / ema_slow | 20 / 50 | 5..100 / 10..250，fast < slow |
| rsi_period / atr_period | 14 / 14 | 5..50 |
| rsi_cross / rsi_ceiling / rsi_fail | 50 / 65 / 45 | cross 40..60；cross < ceiling ≤75；fail 25..50 且 fail < cross |
| volatility_min / volatility_max | 0.001 / 0.02 | 0 < min < max ≤0.05 |
| stop_atr | 2 | 1..4 |
| risk_fraction / notional_fraction | 0.005 / 0.20的规范值0.2 | (0,0.005] / (0,0.20] |
| hold_boundaries / cooldown_full_bars | 36 / 3 | 6..288 / 1..12 |

`warmup_bars = max(250, 5*max(ema_fast,ema_slow,rsi_period,atr_period))`。`parameters_sha256` 由固定策略身份 `s03-ema-rsi-long-flat@v1`、参数schema版本和全部已规范参数的 canonical JSON 计算；不含账户、调用时间、模型摘要或数据观察时间。它是参数身份，不宣称已经通过图编译/用户激活。

策略卡用0.20等数值展示，不要求把格式差异当不同策略。外部 UI 的数字格式规范化属于输入适配；内核只接受上述唯一规范表示，不静默修改非法值。

## 3. 原生指标和纯条件

`runner/s03_indicators.py` 内部构造 ExponentialMovingAverage 两个实例；RSI 和 ATR 均显式 MovingAverageType.Wilder，ATR use_previous=True。只调用锁定原生指标的 update_raw/handle_bar，不调用另一个软件的默认算法。

EMA/RSI/ATR 的数值为原生 binary64；RSI在比较/展示前乘100。输出标明该数值模式，不声称指标为精确货币金额。价格原文与版本须保留，后续止损/预算适配另行明确从指标到Decimal及tick的转换；本段不计算仓位/手续费/盈亏。

比较桥接固定为 Python `str(native_float)` 的最短 round-trip 十进制再转 `Fraction`；RSI先乘100再桥接。参数字符串直接转Fraction；ATR/close用两个桥接值的精确比值，不先做float除法。所有比较与环境Decimal精度无关，无epsilon或阈值舍入。例：ATR=2.0、close=100.0必须包含0.02上端点；更高精度参数保持其精确阈值。这是原生浮点输出的确定性比较语义，不是指标精确性的声明。

纯函数 `evaluate_s03_market(snapshot, parameters)` 返回四个布尔事实：trend_up、rsi_cross_up、volatility_allowed、market_match。snapshot为冻结的有界类型，所有native数值必须有限，EMA/close正值、ATR非负、RSI在0..100，previous RSI允许None。

- trend_up：fast > slow 且 close > fast；相等失败。
- rsi_cross_up：previous存在且 previous ≤ cross < current ≤ ceiling。
- volatility_allowed：ATR >0 且 min ≤ ATR/close ≤ max；两个端点包含。
- market_match：以上三项都成立。指标就绪/时序/TTL由流层再约束；这个事实不检查账户、新闻、权限或保护，不是下单批准。
- 附带 momentum_below_fail 和 trend_invalid 作为未来B/C所需的当根事实；持仓后的连续两根计数、36根期限和唯一退出仍由执行状态层负责，不能在未知持仓时先累计B退出。

## 4. 连续闭合流

入口：`S03SignalStream(parameters, instrument_id, source_revision, *, seed_close_ns: int)`；`update(bar: Bar, *, source_revision: str, available_at_ns: int) -> S03SignalObservation`。实例固定品种、来源修订及原始指标种子close；种子必须来自已核验数据绑定，第一根必须恰等于seed_close_ns。原生 BarType 必须是该 BTCUSDT 品种的5-MINUTE-LAST-EXTERNAL。`instrument_id`和修订来自受信装配，字符串格式校验不构成交易所品种鉴真。外部元数据仍由T2负责。

接受前核对：精确native Bar类型与BarType；OHLC关系和非负volume；正价、有限转换；UTC整5分钟边界；`close_ns >= 300_000_000_000`；`close_ns ≤ ts_init ≤ available_at_ns`；全部时间为非bool uint64，且构造expiry不会溢出。`available_at_ns`是历史回放当时可用时间，不读取现实墙钟。

每次新闭合bar严格递增，跨根available_at_ns必须非递减（同批可相等）。重复、较旧bar或可用时间回退返回固定输入拒绝，不更新指标/计数/最后可用时间，不刷新机会；同close不同内容同样拒绝。来源修订改变必须新建流并重放已验证原文；不追改已有结论。当前版本不提供不透明指标快照恢复：恢复同一流必须从同一seed、同一修订、同一可用时间记录完整重放到目标，不能用尾部250根冒充。显式另选seed属于新的分析谱系，不改变已有信号/授权。

若新close不等于前close+5分钟，重置全部原生指标、上一RSI和连续计数，再把当前bar作为新窗口第1根并记录segment_seed_close_ns。原始seed不改变。保存由配置/原始seed/来源及每根原文、close/init/available时间递推的prefix_sha256，作为重放比对证据；它不是来源鉴真或激活凭证。待重新达到warmup_bars、全部原生initialized并已有上一RSI后才ready。默认第249根不ready、第250根可ready；不是额外等第251根。无界历史数组不保存在流中。

Observation保留：策略/参数身份、来源修订、品种、seed/segment_seed_close_ns、prefix_sha256、bar_close_ns、available_at_ns、原始close、连续计数、ready、gap_reset、指标快照、条件事实、`expires_at_ns=bar_close_ns+5_000_000_000`、expired及可选S03MarketSignal。Signal也携带同一谱系。仅ready、market_match且`available_at_ns < expires_at_ns`才产生Signal；等于截止时间按过期处理。以后消费与原子预留必须重新校验同一绝对期限。

Signal的确定性key由策略身份+参数哈希+品种+close_ns+UPWARD_RSI_CROSS计算；来源修订作为证据保留，不让同一规则同一bar因重送/重放获得另一个机会身份。Signal固定 `execution_authorized=False`、`scope=MARKET_SIGNAL_ONLY`。同币种同策略可共享此公共事实，私人账户批准不能随之共享。

未知/无效数据的拒绝不生成Signal；调用服务必须据失败更新数据锁，本组件不声称替代账户/新闻/保护状态机。旧RSI持续在阈值之上不会不断生成新机会；冷却、账户空仓及无在途买单仍需执行层重验。

## 5. 验证与验收边界

实际锁定指标重核（2026-10-25）：EMA3序列 `[1,2,3,4,3,2,2,2]` 为 `[1,1.5,2.25,3.125,3.0625,2.53125,2.265625,2.1328125]`；Wilder RSI第5/6值为0.5846153846153846/0.3601895734597157；ATR3 Wilder/use_previous 第1..4值为2/2/3/2.3333333333333335，第3根initialized。与既有策略卡观察一致。这是指标探针，不是产品策略验收。

实现后须验证：参数全部边界/跨字段/哈希；50/65/45、EMA相等、波动端点和ATR零；完整非默认参数；原生黄金序列与平价/下降；249/250以及更长周期预热；缺根重置、重复/乱序/修订拒绝不刷新状态；收盘/到达/过期与溢出；前缀因果、确定性重放/机会key；同一合成BTC序列产生有限机会且跨越才触发。

仅覆盖 S03-T01、T02以及T03的信号部分。T04私有预留、T05–11订单/账户/退出/恢复、T12图与PAPER一致性、T13图分支、T14用户激活仍未通过。对策略利润、真实API、执行时延P95和18角色编排不作通过声明。

## 6. 文件与后续接线

- 新 domain/s03_signal.py：参数、参数hash、有限快照/条件/Signal合同。
- 新 runner/s03_indicators.py：原生指标与闭合流；不新增Strategy订单作者。
- 新 tests/unit/domain/test_s03_signal.py 与 tests/compat/test_s03_indicators.py：合同反例与真实锁定指标。
- 主会话维护；不改T1/DB/schema6、旧SMA、registry/API、UI、依赖、共享策略卡业务值。
- 后续顺序：有限图/参数编译并绑定同一hash → 元数据与Q03无损适配 → Astarter状态层重验账户/新闻/期限与幂等预留 → 原生执行/保护 → 同一回放证据及界面。依赖未满足时显示对应未验证状态。

## 7. 规格复核

独立builder审查提出数值桥接、可用时间回退、恢复种子三项行为缺口。主会话已以上述确定规则闭合；审查者确认决策足够并独立验证数值/EMA反例。详细报告保留在任务目录 `s03-signal-builder-review-20261025.md`。该结论只允许本信号组件实施，未批准交易激活。
