import {presentationCopy} from './product-presentation.mjs';
import {messages} from './locale-messages.mjs';
import {LOCALES,normalizeLocale,localeInfo,createMessageCatalog} from './locale-registry.mjs';
import {translateAssetText} from './data-asset-locale.mjs';
import {englishCopy} from './locale-en.mjs';
// Local, deterministic UI translations. No external translation service, data or keys.
export const translations=new Map(Object.entries({
"交易枢纽":"Trading hub","我的交易":"My trading","交易记录":"Trade history","组合体验":"Portfolio preview","账户资产":"Account assets","浏览策略":"Browse strategies",
"已有交易或持仓，请先到交易枢纽处理。":"An existing trade or position needs attention. Handle it in the trading hub first.","模拟订单已提交，可在交易枢纽查看成交与保护。":"Simulated order submitted. View fills and safeguards in the trading hub.",
"发现策略":"Discover strategies","资产信息":"Assets",
"Astarter 风控策略":"Astarter risk strategy",
"看看还剩多少钱、持有什么，以及花了多少手续费。数据均为本地模拟。":"Review your cash, holdings and fees. All figures are simulated.","查看每笔订单的状态、成交和手续费。点击订单可以看详情。":"Review order status, fills and fees. Open an order for details.","总资产":"Total assets","资产增减":"Asset change","持仓价值":"Position value","查看统计方式":"Calculation details","记录怎么算":"How records are calculated","费用算法":"Fee calculation","信号 / 交易":"Signal / trade","已记录订单":"Recorded orders","已有成交":"Orders with fills","订单记录":"Order records","交易动态":"Trade updates","总资产变化":"Total asset changes","资产变化怎么算":"How assets changed","起始资产":"Starting assets","当前资产":"Current assets",
"策略检查":"Strategy check","交易方式":"Trading mode","累计亏损暂停线 / USDT":"Simulation loss limit / USDT","检查通过":"Checks passed","等待交易结果":"Awaiting trade confirmation","暂停买入":"Pause buys","已暂停买入":"Buys paused","继续检查":"Continue checking","重新检查":"Run checks again",
"交易运行":"Trading activity",
"宏观与舆情":"Social & macro","向前查看":"Previous window","向后查看":"Next window","缩小图表":"Zoom out","放大图表":"Zoom in","显示全部数据":"Show all data","搜索资金样本":"Search flow samples","成交方向示意":"Trade-flow illustration","查看证据":"View evidence","K线周期":"Candle interval",
"研究版本已变化，暂停新增风险；已有模拟持仓保留。":"Research changed. New entries are paused; existing simulated positions remain.",
"帮我选策略":"Help me choose","聪明钱跟随":"Smart-money following","我的贡献":"My contributions",
"策略库":"Strategy library","我的策略":"My strategies","策略核验":"Validation","策略信号":"Strategy signals","机会与信号":"Research discoveries","机会发现":"Discoveries","待办事项":"Action inbox","市场行情":"Market data","AI 与链上追踪":"AI & on-chain","资产报表":"Asset reports","执行权限":"Permissions","风险与保护":"Risk & protection","积分与用量":"Credits & usage","连接与设置":"Connections","策略广场":"Strategies","账户与设置":"Account","AI 现场":"AI scene",

"关闭详情":"Close details",
"持仓与现金":"Positions & cash",
"研究成本":"Research costs",
"委托方向":"Order side",
"搜索委托":"Search orders",
"已成交金额 × 0.10%":"Filled notional × 0.10%",
"原模拟回执已确认，等待原委托的分步成交。":"Original fixture receipt confirmed; waiting for fills on the original order.",
"原委托模拟回执已送达，可查询原结果。":"The original fixture receipt has arrived. Query the original result.",
"回执未知，保留原操作和资金占用。":"Receipt unknown; original operation and reservation retained.",
"原操作仍待核对；查询未生成新委托，资金占用保留。":"The original operation remains unconfirmed. The query created no order; funds remain reserved.",
"入场条件命中 · 预设信号示例":"Entry condition triggered · scripted signal",
"退出条件命中 · 预设信号示例":"Exit condition triggered · scripted signal",
"模拟保护回执确认；新增风险仍需明确恢复。":"Simulated protection confirmed. Explicitly resume before opening new risk.",
"手机产品导航":"Mobile product navigation",
"数据中心":"Data hub",
"数据中心 · 样例数据采集与核验":"Data hub · Collect and verify sample data",
"网络":"Scene",
"手机工作区":"Mobile workspace",
"Agent 采集的数据源":"Agent data sources",
"开放的流动证据线束与白色协作核心，Agent 往返数据面板采集并交接":"Agents collect and hand off evidence around the collaboration core",
"查看盘口深度来源与记录":"Inspect depth sources and records",
"查看趋势结构来源与记录":"Inspect trend sources and records",
"查看宏观事件来源与记录":"Inspect macro sources and records",
"查看社交舆情来源与记录":"Inspect sentiment sources and records",
"查看链上异动来源与记录":"Inspect on-chain sources and records",
"查看风险条件来源与记录":"Inspect risk sources and records",
"Crypto + TradFi · 分组协作":"Crypto + TradFi",
"跨组协作":"Cross-team work",
"共享美元背景":"Shared dollar context",
"共享利率背景":"Shared rate context",
"等待下一轮证据":"Awaiting the next evidence refresh",
"运行状态与协作信息":"Session state and collaboration",
"白色协作核心、彩色流线与 Agent 动向":"Core, evidence streams and agent activity",
"Agent 数据采集与交接":"Agent collection and handoff",
"六个研究小组":"Six research teams",
"采样":"Sampling",
"示例价":"Fixture price",
"HIVE 蜂巢样片首页":"HIVE simulation home",
"Astarter 首页":"Astarter home",
"运行模式":"Run mode",
"仅信号":"Signals only",
"保存并继续":"Save & continue",
"稍后设置":"Set up later",
"演练状态":"Validation status",
"账户敞口上限 / USDT":"Account exposure cap / USDT",
"每日研究上限 / 体验积分":"Daily research cap / demo credits",
"管理资源":"Manage resources",
"选择研究覆盖面，不必逐一填交易对。具体资产在出现机会后展示。":"Choose market coverage; no need to list individual pairs. Specific assets appear when opportunities are found.",
"当前模拟覆盖 8 类资产与 6 个研究小组。TradFi 为研究观察，不开放交易适配。":"This simulation covers 8 assets and 6 research teams. TradFi supports research only, with no execution adapter.",
"使用模拟账户、固定数据与 Agent 剧本即可开跑；无真实凭据。":"Start with a simulated account, fixed data and scripted agents. No real credentials are needed.",
"切换模式会产生新草稿版本，需要重新演练后才能启动交易。你可以先开启研究，再处理机会。":"Changing mode creates a new draft version that must be validated before trading. You can start research first.",
"不扣真实资金；已有仓位退出不受研究积分限制。":"No real funds are charged. Research credits never restrict exits for existing positions.",
"本轮每次深度核验最多":"Each deep research task reserves up to ",
"积分，策略交互演练最多":"credits; strategy validation up to ",
"，启动私有复核":"and a private account check costs ",
"。未使用预留释放。":". Unused reserves are released.",
"连接与配置":"Connections & settings",
"关闭连接配置":"Close connection settings",
"连接分类":"Connection types",
"配置概览":"Overview",
"本地模拟环境":"Local simulation",
"配置决定样片如何运行。真实凭据与外部服务尚未接入。":"Settings control the simulation. Real credentials and external services are not connected.",
"检查模拟配置":"Check demo configuration",
"保存配置":"Save configuration",
"所有连接均为本地示例。":"All connections are local fixtures.",
"准备好你的工作空间":"Prepare your workspace",
"先启用交易账户、研究数据和模型配置，再前往工作台开始研究。":"Enable a demo trading account, research data and model settings, then start research in the workspace.",
"必要配置已启用":"Required resources enabled",
"可开始模拟研究":"Ready for simulated research",
"还有配置需要完善":"Configuration incomplete",
"盘面 / 宏观 / 舆情 / 链上":"Market / macro / social / on-chain",
"可选 · 不影响 CEX 现货模拟":"Optional · Does not affect CEX spot simulation",
"站内提示与执行回报":"In-app alerts & execution receipts",
"未启用":"Disabled",
"下一步：完成初始设定":"Next: finish initial setup",
"选择盘口、策略与执行方式，最多 5 步启动。":"Choose coverage, strategy and execution mode in up to five steps.",
"打开初始设定":"Open initial setup",
"交易场所":"Venue",
"模拟账户":"Simulated account",
"允许范围":"Allowed markets",
"读取示例行情":"Read fixture prices",
"模拟委托":"Simulated orders",
"提现关闭":"Withdrawals disabled",
"API 凭据由后续安全服务托管，本样片不接收真实 Key。启用这里只改变模拟状态。":"Future credentials require a secure service. This preview accepts no real keys; enabling changes simulation state only.",
"盘口与技术":"Order book & technicals",
"盘口、价量、趋势与波动":"Depth, price, volume, trend and volatility",
"经济日历、美元与风险资产":"Economic calendar, dollar and risk assets",
"讨论热度、去重与出处核验":"Discussion activity, deduplication and source checks",
"地址转账、合约活动与旁证":"Transfers, contract activity and contextual evidence",
"四类数据共用研究流程；开启配置不会请求外部 API。每条线索保留来源类型和证据编号。":"All four source types share the research flow. Enabling makes no external API requests. Leads retain source type and evidence ID.",
"模型提供方":"Model provider",
"自有模型网关":"Own model gateway",
"仅保存提供方偏好；未进行模型调用。":"Saves provider preference only. No model calls are made.",
"每次研究预算上限":"Budget cap per research task",
"范围 1–100 USD，仅为配置演示，无实际计费。":"Range: 1–100 USD. Configuration demonstration only; no actual billing.",
"角色池":"Role pool",
"18 个研究与执行角色":"18 research and execution roles",
"决策边界":"Decision boundaries",
"研究 → 独立风控 → 模拟执行":"Research → Independent risk check → Simulated execution",
"密钥托管":"Key custody",
"服务待接入 · 不开放真实凭据":"Not integrated · No real credentials accepted",
"链上钱包尚未连接":"On-chain wallet not connected",
"本轮使用 CEX 现货模拟，无需连接钱包。此开关用于体验钱包状态。":"This CEX spot simulation needs no wallet. The switch demonstrates wallet state only.",
"无地址读取":"No address access",
"无签名请求":"No signing requests",
"无资金转移":"No fund transfers",
"链上转账线索来自固定样例，不能视为此钱包的真实活动。":"On-chain leads use fixed fixtures; they do not represent activity from this wallet.",
"提交、部分成交、成交和撤销":"Submission, partial fill, full fill and cancellation",
"运行与风控":"Session & risk",
"暂停、新风险阻断、研究版本变化":"Pauses, risk blocks and research version changes",
"回报记录":"Receipt history",
"即时提示关闭后，日志仍然保留":"Logs remain available when pop-up alerts are off",
"预览站内通知":"Preview notification",
"当前仅站内提示，关闭页面后不运行或推送；邮件、Telegram 等通道未接入。":"In-app alerts only. Closing the page stops activity; email and Telegram are not connected.",
"可选配置":"Optional configuration",
"选择即时提示偏好":"Choose alert preferences",
"模拟运行所需配置":"Required for simulation",
"修改后保存，下一次运行生效":"Save changes for the next run",
"显示站内即时通知":"Show in-app alerts",
"不影响现货模拟启动":"Does not affect spot simulation",
"当前运行保留启动时的配置快照":"Current runs keep their original configuration",
"启用":"Enable ",
"示例":" demo",
"共享证据协查":"Shared-evidence review",
"策略核验":"Strategy validation",
"成交与费用复盘":"Fill & fee review",
"委托与回报交接":"Order & receipt handoff",
"异常回执复核":"Exception review",
'Crypto + TradFi · 分组协作 · 示意':'Crypto + TradFi · SIM','AI 协作台':'AI Workspace','蜂巢':'Hive','交易工作台':'Trading workspace','Lego AI Quant · 本地模拟':'Lego AI Quant · Local simulation','演示数据':'Demo data','仅供界面体验':'Simulation only','界面配色':'Appearance','浅色':'Light','深色':'Dark','产品页面':'Product navigation','发现':'Discover','策略':'Strategies','交易':'Trading','账户':'Account','体验积分':'Demo credits',
'运行概览':'Overview','观察范围':'Coverage','当前核验':'Current research','当前方案':'Workflow','配置版本':'Configuration','参与 Agent':'Agents','传递记录':'Handoffs','本轮参与':'Team roster','按需调度':'On demand','当前节点':'Selected agent','当前聚焦的 Agent':'Selected agent','观察记录':'Research record','查看职责与输出':'Role & output','事件记录':'Activity','本地演示':'Local demo','本轮未调用':'Not assigned','等待交接':'Awaiting handoff','处理中':'In progress','已中止':'Stopped','多组研究进行中':'Teams researching','全域研究 / 6 个研究小组':'Market-wide / 6 research teams','多维度独立研究':'Independent, multi-source research','多资产协作':'Multi-asset collaboration','分组协作':'Team collaboration','全域研究':'Market-wide','核心处理':'Core task','等待报告':'Awaiting reports','已汇总':'Reviewed','候选':'Candidates','采集':'Collect','会审':'Cross-check','递交':'Deliver','巡查':'Monitor','研究记录':'Research records','暂停协作':'Pause animation','继续协作':'Resume animation',
'市场环境':'Market context','多周期趋势':'Multi-timeframe trend','价格行为与形态':'Price action','成交量与量价':'Price & volume','盘口与流动性':'Order book & liquidity','波动与异常':'Volatility & anomalies','策略规则映射':'Strategy rules','做多论证':'Long thesis','减仓与卖出论证':'Exit thesis','反证质询':'Counter-evidence','等待与不交易':'Wait & budget','情景路径':'Scenario analysis','决策整合':'Decision synthesis','组合与敞口':'Portfolio exposure','资本保护审阅':'Capital protection','执行质量评估':'Execution quality','运行异常诊断':'Execution diagnostics','交易归因与复盘':'Attribution & review',
'市场结构':'Market structure','链上生态':'On-chain','情绪异动':'Sentiment','全球权益':'Global equities','避险轮动':'Defensive rotation','宏观事件':'Macro','市场结构组':'Market team','趋势研究组':'Trend team','生态研究组':'On-chain team','异动研究组':'Sentiment team','权益研究组':'Equities team','避险研究组':'Defensive team','宏观研究组':'Macro team',
'盘口深度':'Depth','趋势结构':'Trend','社交舆情':'Sentiment','链上异动':'On-chain flows','风险条件':'Risk checks','量价关系':'Price & volume','买卖价差':'Spread','波动区间':'Volatility','指数':'Index','热度':'Score','角色':'Roles','核心汇总':'Core review','发现与机会':'Discoveries & opportunities','筛选研究任务':'Filter research','新发现':'New findings','全部记录':'All records','策略候选':'Strategy candidate','研究详情':'Research details','行情':'Market','流动':'Liquidity','宏观':'Macro','舆情':'Social','链上':'On-chain','风险':'Risk','保留':'Retained','旁证':'Context','分歧':'Conflict','待补':'Missing','不适用':'N/A','等待采集':'Pending collection','采集证据':'Collecting evidence','组内核验':'Team verification','等待汇总':'Queued for core','核心复核':'Core review','结论已汇总':'Conclusion ready','排队研究':'Queued','持续观察':'Monitoring','继续观察':'Keep watching','进入策略候选':'Strategy candidate','共享情报':'Shared intelligence','背景与旁证，不能单独放行交易':'Context only; cannot authorize a trade.','宏观日历':'Macro calendar','舆情交叉核验':'Sentiment cross-check','来源去重与情绪分歧':'Source deduplication and sentiment conflicts','利率事件与美元背景':'Rate events and dollar context','大额转账与资金流旁证':'Large transfers and flow evidence','最近协作':'Recent collaboration','市场走势参考':'Market reference','合成序列':'Synthetic series','全市场 · 起点 100':'All markets · rebased to 100','黄金现货':'Spot gold','黄金':'Gold','以太坊':'Ethereum','标普 500':'S&P 500','纳斯达克 100':'Nasdaq 100','美元指数':'Dollar index','美国十年国债':'US 10-year Treasury',
'研究进行中':'Research in progress','示例连接就绪':'Demo connections ready','执行标的':'Market','机会自动匹配':'Match a discovered opportunity','模拟交易所 · 现货':'Simulated venue · Spot','策略版本':'Strategy version','执行方式':'Execution mode','逐笔确认':'Confirm each trade','自主模拟':'Autonomous simulation','只看信号':'Signals only','单笔':'Per order','敞口上限':'Exposure cap','运行配置':'Run configuration','编辑仅影响下次启动':'Changes apply to the next run','入场、等待与保护条件':'Entry, wait & protection','核验此盘口':'Research this market','启动模拟':'Start simulation','启动私有复核':'Private check on start','编辑策略':'Edit strategy','积分账单':'Credit ledger','模拟账面':'Simulated cash','累计手续费':'Total fees','暂无模拟持仓':'No simulated position','退出模拟持仓':'Close simulated position','已停止运行':'Stopped','操作台':'Trading desk','运行设置':'Run settings','操作分组':'Desk sections','画面':'Visuals','机会接管 · SIM':'Opportunity dispatch · SIM','等待开启机会接管':'Opportunity dispatch is off','开启机会接管':'Enable opportunity dispatch','关闭机会接管':'Disable opportunity dispatch','全域研究中；发现后可自动接管，也可从机会详情手动交接。':'Scan all markets. Dispatch automatically or select a finding.','机会已交接，当前会话独立运行':'Opportunity handed off; the session runs independently.','已交接 · 模拟执行中':'Handed off · Simulation running','配置执行方式与限额，开启机会接管。':'Set the mode and limits, then enable dispatch.','最多':'Up to','暂停':'Pause','恢复':'Resume','停止运行':'Stop run','回报':'Receipts','研究':'Research','操作':'Desk','状态':'Status','配置':'Settings','核验':'Verify','已核验':'Verified','待补证':'Missing evidence','已撤回':'Withdrawn','权限复核':'Access check','待对账':'Reconcile','部分成交':'Partial fill','复盘':'Review','异常':'Exception','执行':'Execution','积分预留':'Credit reserve','积分结算':'Credit settlement','释放预留':'Release reserve','锁 ':'Hold ','退 ':'Release ',
'工作空间配置':'Workspace settings','必要配置':'Required','可用':'Ready','交易账户':'Trading account','研究数据':'Research data','AI 模型':'AI models','链上钱包':'On-chain wallet','执行通知':'Execution notifications','示例已启用':'Demo enabled','可选 · 未连接':'Optional · Not connected','管理配置':'Manage settings',
'当前分区':'Section navigation','模拟环境':'Simulation','机会雷达':'Opportunity radar','我的策略':'My strategies','策略广场':'Strategy library','策略验证':'Validation','策略验证与演练':'Strategy validation','交易执行中心':'Execution center','执行中心':'Execution','账户风控':'Risk limits','交易日志':'Trading logs','资产报表':'Asset reports','积分与用量':'Credits & usage','初始设定':'Get started','市场数据':'Markets','资金与链上':'Flows & on-chain','AI 追踪':'AI tracking','社交与宏观':'Social & macro','情报中心':'Intelligence','返回协作台':'Back to workspace','返回我的策略':'Back to my strategies','返回机会':'Back to opportunities','查看交易日志':'View trading logs','查看账单':'View ledger','查看 Agent 协作':'View agent activity','查看关联草稿':'View draft','查看演练报告':'View validation report','查看策略验证':'View validation','查看研究发现':'View findings','查看执行实例':'View execution instance',
'账户权益':'Equity','账面现金':'Book cash','手续费':'Fees','当前实例':'Current instance','已暂停新开仓':'New entries paused','实例控制':'Session controls','研究来源':'Research source','模式':'Mode','对象':'Market','模拟授权':'Simulation authorization','额度':'Limits','暂停新开仓':'Pause new entries','恢复模拟':'Resume simulation','停止实例':'Stop session','信号与持仓':'Signals & positions','当前没有待确认信号。':'No signals awaiting confirmation.','持仓':'Position','名义':'Notional','保护通道':'Protection channel','可独立提交模拟退出；不依赖积分':'Closing a position does not require credits.','撤销剩余委托':'Cancel unfilled quantity','退出已有持仓':'Close position','Astarter 风控':'Astarter risk limits','委托与成交':'Orders & fills','订单 / 信号':'Order / signal','对象 / 方向':'Market / side','成交数量':'Filled quantity','已成交':'Filled','买入':'Buy','卖出':'Sell','主动退出':'Manual exit','回报场景 · 仅影响下一笔模拟委托':'Receipt scenario · Applies to the next order','模拟回报剧本':'Simulated receipt scenario','正常 · 部分成交后完成':'Normal · Partial then full fill','拒绝 · 不生成成交':'Rejected · No fill','回执未知 · 需要手动对账':'Unknown · Manual reconciliation required','未知状态保留委托意图，阻止新单；对账前的资产仅为已确认账面。':'Unknown receipts retain order intent and block new orders. Balances show confirmed fills only.','站内通知':'In-app notifications','全部标为已读':'Mark all read','当前没有待确认信号':'No pending signal','模拟对账':'Reconcile simulation','确认执行':'Confirm execution','跳过信号':'Skip signal','模拟成交':'Simulated fill','已提交':'Submitted','已拒绝':'Rejected','回执未知':'Unknown receipt','已撤销':'Cancelled','部分成交后撤销':'Partially filled, remainder cancelled',
'全部策略':'All strategies','结构与技术':'Structure & technical','事件与情报':'Events & intelligence','搜索策略':'Search strategies','搜索策略名称或编号':'Search by name or ID','规则详情':'Rules','复制为我的策略':'Copy to my strategies','研究流程演练':'Research workflow demo','现货交互演练':'Spot workflow demo','未实现 / 未回测':'Not implemented / Not backtested','证据':'Evidence','规则':'Rules','风控':'Risk','保护':'Protection','个人版本':'Personal versions','添加策略':'Add strategy','单笔名义':'Order notional','策略敞口上限':'Strategy exposure cap','执行模式':'Execution mode','保存参数版本':'Save parameter version','演练当前已保存版本':'Validate saved version','执行预案与证据':'Execution plans & evidence','A / B / C 预案':'A / B / C scenarios','数据依赖与验证方法':'Data dependencies & validation','用于已选机会':'Use for selected opportunity','演练记录':'Validation history','交互报告':'Workflow report','交互演练通过':'Workflow passed','演练内容':'Validation scope','配置与版本':'Configuration & version','必需来源与时效':'Required sources & freshness','账户权限和资金约束':'Permissions & capital limits','信号、订单、回报关联':'Signal, order & receipt linkage','积分任务':'Credit task','验证性质':'Validation type','模拟交互 · 非策略性能验证':'UI simulation · Not a strategy performance test','取消并释放预留':'Cancel & release reserve','异常场景':'Exception scenarios','正常流程':'Normal flow','必需数据缺项':'Missing required data','按当前场景演练':'Run this scenario','正在按固定剧本检查交互状态…':'Checking the scripted UI workflow…','模拟合同、权限与订单交互检查完成；不是指标回测。':'Simulated contract, permissions and order workflow checked. No indicator backtest was run.','样例缺少必需数据，执行被阻断。':'Required fixture data is missing. Execution is blocked.','参数校验、来源缺项、模式权限、重复启动和积分预留均可在这里体验。真实指标、历史数据与 Nautilus 回测尚未接入。':'Try validation, missing data, mode permissions, duplicate-start prevention and credit reserves. Indicators, historical data and Nautilus backtests are not connected.',
'这里运行的是前端状态与异常路径演练，不是历史回测；不会产生胜率、年化或真实交易结论。':'These are UI state and exception-path checks, not historical backtests or performance forecasts.','18 条研究流程，保留原版与子版。复制后编辑参数、运行交互演练，再决定如何执行。':'18 research workflows with preserved originals and variants. Copy one, edit parameters, validate the workflow, then choose an execution mode.','草稿、演练和启动使用明确版本。修改参数会让旧演练失效，运行中的实例继续使用已锁定配置。':'Drafts, validation and execution use explicit versions. Edits invalidate prior validation; running sessions keep their locked configuration.','与右侧操作台共用同一模拟账本。信号、委托、部分成交、持仓和退出分别记录。':'Shares one simulation ledger with the trading desk. Signals, orders, partial fills, positions and exits are recorded separately.',
'均线 + RSI · 内置演练':'MA + RSI · Built-in demo','均线＋RSI（冻结原版）':'MA + RSI (frozen original)','H5 多周期结构/PA/能量/点位':'H5 multi-timeframe structure / PA / energy / levels','现货有限买方网格':'Bounded spot buy grid','三层有限马丁/均值回归篮子':'Three-layer bounded mean-reversion basket','缠论启发：确认中枢后三买':'Chan-inspired confirmed third buy','日内订单簿剥头皮':'Intraday order-book scalping','波浪启发：确认4浪后的5浪尝试':'Wave-inspired confirmed fifth-wave attempt','威科夫价量：Spring＋Test确认':'Wyckoff spring & test confirmation','裸K：顺结构Inside Bar突破':'Price-action inside-bar breakout','同链池间原子套利':'Same-chain atomic pool arbitrage','集中流动性LP库存管理（新增子版）':'Concentrated-liquidity LP inventory (variant)','宏观事件后延续':'Post-macro-event continuation','原帖叙事扩散与现货确认':'Narrative propagation & spot confirmation','聚合关注与互动异常':'Attention & engagement anomalies','定点池链上成交倾斜':'On-chain pool flow imbalance','原生BTC实体净流出异常':'Native BTC entity outflow anomaly','解锁/分发压力防御覆盖层':'Unlock / distribution defense overlay','单所杠杆清理后的现货确认':'Post-deleveraging spot confirmation',
'结构与流动性证据一致，链上流入提供旁证。':'Structure and liquidity agree; on-chain inflows add context.','舆情热度上升，但大额流动与盘口证据相反。':'Sentiment is rising, but large flows conflict with order-book evidence.','指数走强，但权重集中度证据仍缺失。':'The index is stronger, but concentration evidence is missing.','避险需求与利率背景形成交叉支持。':'Defensive demand and rate conditions support each other.','分歧 · 暂缓跟进':'Conflict · Hold off','待补 · 权重证据':'Missing concentration evidence','避险候选 · 待跟踪':'Defensive candidate · Monitor','等待结构确认':'Awaiting structure confirmation','等待事件落地':'Awaiting event resolution','利率背景已更新':'Rate context updated','美元背景已更新':'Dollar context updated','定期检查新证据':'Scheduled evidence refresh','组内发现 · 等待复核':'Team finding · Awaiting review','存在分歧':'Conflicting evidence','证据待补':'Missing evidence','组员正在执行复核，本任务等待释放。':'Team members are handling execution checks; this task is waiting.','各组正在采集与核验，发现会在这里浮现。':'Teams are collecting and verifying evidence. New findings appear here.',
'可用积分':'Available credits','累计消耗':'Credits spent','预留中':'Reserved','日预算':'Daily budget','今日用量':'Today’s usage','补充体验积分':'Add demo credits','无真实支付':'No real payment','模拟赠送':'Demo grant','本地记录':'Local records','任务账单':'Task ledger','类型':'Type','关联对象':'Linked record','计价规则':'Pricing rule','预留 / 结算 / 释放':'Reserved / charged / released','状态与原因':'Status & reason','等待完成':'Awaiting completion','策略流程演练':'Strategy workflow validation','深度核验':'Deep research','账户私有复核':'Private account check','已结算':'Settled','已取消':'Cancelled','已完成':'Completed','进行中':'In progress','草稿':'Draft','未开始':'Not started','积分':'Credits',
'已连接':'Connected','未连接':'Disconnected','保存':'Save','取消':'Cancel','关闭':'Close','下一步':'Next','上一步':'Back','完成设置':'Finish setup','开始运行':'Start','开始研究':'Start research','模拟连接':'Simulate connection','断开':'Disconnect','全部':'All','搜索':'Search','详情':'Details','来源':'Source','时间':'Time','通知':'Notifications','金额':'Amount','数量':'Quantity','版本':'Version','账户上限':'Account cap','日损上限':'Daily loss cap','日研究预算':'Daily research budget','保存风控':'Save risk limits','保存预算':'Save budget','使用自备 Key':'Use your own key','余额':'Balance','消费记录':'Usage history','查看':'View','研究组':'Research team','共享背景':'Shared context','组采集核验':'teams researching','项等待':'queued','项已汇总':'reviewed','组研究中':'teams researching','个相关资产':'related assets','类资产':'asset classes','条未读':'unread','个 Agent':'agents','个研究组':'research teams','模拟执行中':'Simulation running','模拟执行已暂停':'Simulation paused','模拟执行已停止':'Simulation stopped','组内核验完成，报告等待核心':'Team review complete; report queued for core','向核心递交报告':'Delivering report to core','开始新一轮扫描':'Starting a new scan','报告交接与复核；其余小组继续研究。':'Report handoff and review; other teams continue.','其余小组继续研究。':'Other teams continue.','前往采集':'Collecting','原始情报直送':'Direct intelligence delivery','交叉核验':'Cross-check','广域扫描':'Broad scan','等待新证据':'Awaiting new evidence','交互演练':'Workflow demo','本地模拟':'Local simulation','演练':'Validation','演示':'Demo','模拟':'Simulated'
}));
const exactOverrides=new Map(Object.entries({
'新闻舆情':'News & sentiment','社媒动态':'Social activity','合约与清算':'Derivatives','ETF 资金':'ETF flows','模拟样本':'Demo data','样本快照':'Snapshot',
'从价格、资金和杠杆变化，找到值得继续看的市场。':'Find markets worth watching through price, flows and leverage.',
'查看链上变化，留下线索，再交给 AI 继续研究。':'Explore on-chain changes, save a lead and send it for research.',
'把重要事件、资金变化与市场反应放在一起看。':'Read key events alongside fund flows and market reactions.',
'关注有用的观点，也看交易员实际改变了什么。':'Follow useful ideas and see what traders actually change.',
'比较杠杆成本、持仓变化和被动平仓，观察市场是否拥挤。':'Compare funding, open interest and liquidations to assess crowding.',
'对照每日申赎，观察资金是否持续进入。':'Compare daily subscriptions and redemptions to watch persistent flows.',
'全部动态':'All activity','已关注':'Following','持仓变化':'Position changes','研究观点':'Research notes','我的信息流':'My feed',
'值得观察的账户':'Accounts to watch','讨论中的资产':'Discussed assets','样例合约持仓':'Sample open interest','样例合计':'Sample total',
'24h 清算':'24h liquidations','多空持仓比例':'Long / short exposure','最近一日净流入':'Latest net inflow','跨市场观察':'Cross-market watch',
'24h 涨跌榜':'24h movers','24h 持仓变化':'24h OI changes','市场一览':'Market overview','全部':'All','自选':'Watchlist','排序':'Sort',
'价格 / 收益率':'Price / yield','24h 变化':'24h change','24h 成交额':'24h volume','持仓量':'Open interest','资金费率 / 8h':'Funding / 8h','7d 走势':'7d trend',
'链上指标':'On-chain metrics','全部指标':'All metrics','我的追踪':'Tracked metrics','持币与供给':'Holdings & supply','交易所资金':'Exchange flows','网络活动':'Network activity','成本与估值':'Cost & valuation','大额转账':'Large transfers',
'最新样本':'Latest sample','1d 变化':'1d change','7d 变化':'7d change','30d 变化':'30d change','90d 走势':'90d trend','历史变化':'History',
'AI 分析与追踪':'AI analysis & tracking','样例分析':'Sample analysis','另一种解释':'Another explanation','相关指标':'Related metrics','这个指标怎么看？':'How to read this metric',
'经济日历':'Economic calendar','情景日历':'Scenario calendar','正在关注':'In focus','只看重要':'Important only','重要':'Important',
'消息详情':'News detail','AI 解读':'AI perspective','这对观察有什么影响？':'What changes in the watchlist?','已收藏':'Saved','收藏':'Save','收藏消息':'Save story',
'交易所资金费率对比':'Funding rates by exchange','持仓分布':'Open interest distribution','多空清算分布':'Long / short liquidations','资金费率':'Funding rates','清算':'Liquidations',
'每日资金流':'Daily net flows','每日明细':'Daily breakdown','全部基金':'All funds','基金 A':'Fund A','基金 B':'Fund B','基金 C':'Fund C','基金 D':'Fund D','日期':'Date',
'合计 / 百万 USD':'Total / USD million','区间净流入':'Period net inflow','净流入天数':'Days with inflows','基金覆盖':'Fund coverage',
'交给 AI 研究 ↗':'Send for AI research ↗','AI 帮我读这条动态':'AI perspective on this activity','调整前':'Before','调整后 · 账户占比':'After · account allocation','增仓':'Increased','减仓':'Reduced','多头':'Long','空头':'Short',
'搜索市场资产':'Search markets','搜索资产 / 名称':'Search assets / names','搜索链上指标':'Search on-chain metrics','搜索指标 / 资产':'Search metrics / assets','搜索社媒动态':'Search social activity','搜索观点、资产或样例账户':'Search ideas, assets or demo accounts','搜索消息':'Search news','搜索消息 / 资产':'Search news / assets'
}));
// Whole-sentence copy for the task flow and contextual assistant. Exact matches
// are resolved before the general term dictionary, avoiding mixed-language UI.
Object.entries({
 "现场":"Desk",
 "裁定":"Ruling",
 "授权":"Mandate",
 "账本":"Ledger",
 "还没有记录":"No items yet",
 "合同库":"Contract library",
 "运行实例":"Current run",
 "限额":"Limits",
 "修改版本":"Edit version",
 "调整限额":"Adjust limits",
 "只有当前授权处理不了的事项会出现。":"Only items the current mandate cannot settle appear here.",
 "这里规定代理能做和不能做的事。":"These rules define what the agent may and may not do.",
 "研究结果":"Research results",
 "待裁定":"Needs a ruling",
 "代理不执行":"The agent will not execute",
 "去裁定":"Open rulings",
 "打开现场":"Open the desk",
 "修改授权":"Change the mandate",
 "返回授权":"Back to the mandate",
 "选择观察范围":"Choose the research scope",
 "先确认工作资源":"Check your workspace resources",
 "选择策略与处理方式":"Choose a strategy and handling mode",
 "确认模拟资源":"Confirm simulated resources",
 "设定敞口和积分预算":"Set exposure and credit budget",
 "核对后启动":"Review and start",
 "覆盖范围决定线索来源。机会出现后再显示具体资产。":"Scope decides where leads come from. A specific asset appears after an opportunity does.",
 "研究开启后持续采集。合格机会先汇总到核心，再按所选模式处理。":"Collection continues after research starts. A qualified opportunity is summarized by the core, then handled in the selected mode.",
 "只记录信号，不生成模拟委托。":"Record the signal. Do not create a simulated order.",
 "每个合格信号确认后才生成模拟委托":"A qualified signal creates a simulated order only after confirmation",
 "设好风险与研究预算":"Set risk and research budgets",
 "核对，然后开跑":"Review and start",
 "覆盖范围决定 Agent 去哪里找线索，出现机会时再显示具体资产。":"Coverage guides where agents look. Assets appear when an opportunity is found.",
 "本轮使用固定示例数据与模拟账户，随时可从账户页调整。":"This preview uses fixed sample data and a simulated account. You can adjust them later in Account.",
 "选一份个人策略和处理模式。研究可以先开始，执行要等核验通过。":"Choose a personal strategy and decision mode. Research can begin now; execution requires validation.",
 "明确最大敞口与每日积分用量。预算归零只停止新的付费研究任务。":"Set exposure and daily credit limits. A zero budget only stops new paid research tasks.",
 "研究开启后，小组持续采集；合格机会先汇总到核心，再按你的模式处理。":"Teams keep gathering evidence. Qualified opportunities reach the core before your chosen mode handles them.",
 "跨市场观察；当前仅 Crypto 可模拟执行":"Cross-market research; simulated execution is available for Crypto only",
 "只研究数字资产，支持合格机会的模拟执行":"Research digital assets; qualified opportunities can be simulated",
 "只研究传统市场；当前不开放执行":"Research traditional markets; execution is unavailable",
 "只看信号":"Signals only",
 "核心报告机会，由你决定后续操作":"The core reports opportunities; you decide what follows",
 "逐笔确认":"Confirm each order",
 "自主模拟":"Autonomous simulation",
 "通过权限、策略和风控检查后按固定剧本模拟":"Run a fixed simulation after permission, strategy and risk checks",
 "发现、反证和待补项在同一列表。选中一条再决定是否核验。":"Findings, counter-evidence, and open items are in one list. Select one before deciding on a review.",
 "合成市场样本。选定资产后交给研究组交叉核验。":"Synthetic market samples. A selected asset goes to a research team for cross-check.",
 "链上转账只是线索。先核对出处和时间，再决定是否追踪。":"An on-chain transfer is only a lead. Check source and time before tracking it.",
 "宏观事件和舆情先看来源与影响窗口，再交给研究组。":"Check source and impact window before sending macro or social items to a research team.",
 "先看形成条件与风险边界。复制个人版本后才能配置和演练。":"Check the trigger and risk limits first. Copy a personal version to configure and rehearse it.",
 "参数变动会产生新版本。重新演练后才能接管机会。":"A parameter change creates a new version. It can take an opportunity only after a new rehearsal.",
 "模拟信号、订单回报和持仓对应同一账本。未知回执先对账。":"Simulated signals, order receipts, and holdings use one ledger. Reconcile an unknown receipt first.",
 "每笔模拟委托都能回到运行实例与信号；可按状态筛选。":"Every simulated order traces back to a session and signal. Filter by status here.",
 "这里按同一模拟账本核对现金、持仓与费用，不显示未经计算的收益。":"I reconcile cash, holdings and fees against one simulated ledger. Uncalculated returns are omitted.",
 "研究与核验按任务记体验积分；预留、结算和释放可逐笔查看。":"Research and validation use demo credits by task. Review reservations, charges and releases here.",
 "演练只检查流程与异常。阻断关口会标出，不代表历史收益。":"The rehearsal checks the workflow and the failure paths. A blocked step is marked. It is not a historical return.",
 "账户限额和策略限额分开。风险版本变化后，新实例要重新演练。":"Account limits and strategy limits are separate. A new run needs a new rehearsal after the risk version changes.",
 "这里配置本地模拟资源；真实密钥不在这里填写。":"Configure local simulation resources here. Real credentials are not accepted.",
 "协作核心":"Collaboration core",
 "本地模拟":"Local simulation",
 "查看协作核心提示":"Show core assistant tip",
 "收起协作核心提示":"Hide core assistant tip",
 "时间 / 对象":"Time / asset",
 "事件与证据":"Event and evidence",
 "处置":"Assessment",
 "交给小组":"Assign to team",
 "核验":"Verification"
}).forEach(([source,target])=>exactOverrides.set(source,target));
Object.entries({
 "协作":"Workspace",
 "打开协作工作台":"Open AI workspace",
 "页面筛选":"Page filters",
 "搜索标的或事件":"Search assets or events",
 "风险待核验":"Risk review pending",
 "保留旁证":"Context retained",
 "取消关注":"Remove from watchlist",
 "关注":"Watch",
 "候选线索":"Candidate lead",
 "当前样例":"Current fixtures",
 "模拟环境":"Simulation",
 "本浏览器模拟账本":"Local browser ledger",
 "开始使用":"Get started",
 "每一步只决定一件事":"One decision at a time",
 "继续 →":"Continue →",
 "开启研究":"Start research",
 "先选择观察范围。具体资产在机会出现后显示。":"Choose the scope first. A specific asset appears after an opportunity does.",
 "数据、研究角色和账户都是本地模拟。":"Data, research roles, and the account are a local simulation.",
 "研究可以先开始。模拟执行要等演练通过。":"Research can start first. Simulated execution waits until the rehearsal passes.",
 "敞口和积分预算分开计算。预算为 0 时停止新的付费研究。":"Exposure and the credit budget are calculated separately. A zero budget stops new paid research.",
 "核对范围、策略和限额。确认后开始本地模拟。":"Check scope, strategy, and limits. Confirmation starts the local simulation.",
 "固定行情与情报样例":"Fixed market and intelligence fixtures",
 "18 个角色 · 6 个研究小组":"18 roles · 6 research teams",
 "本地账本，不连接交易所":"Local ledger; no exchange connection",
 "信号、执行与风险回报":"Signal, execution and risk updates",
 "已启用":"Enabled",
 "未启用":"Disabled",
 "返回上一步":"Back",
 "个人策略版本":"Personal strategy version",
 "信号处理方式":"Signal handling",
 "更改策略模式会生成新版本；模拟执行前需要重新演练。":"Changing strategy mode creates a new version. Rehearse it before simulated execution.",
 "策略交互演练":"Strategy workflow rehearsal",
 "私有复核":"Private account check",
 "按任务结算":"Charged per task",
 "未使用预留释放":"Unused reserved credits are released",
 "启动机会接管时":"When taking an opportunity",
 "仅消耗本地体验积分；已有模拟仓位的退出不受研究预算影响。":"Only local demo credits are used. Research budgets never block exits from simulated holdings.",
 "确认启动":"Confirm and start",
 "策略与处理":"Strategy and handling",
 "敞口 / 每日积分":"Exposure / daily credits",
 "当前可用积分":"Credits available",
 "同时开启一次机会接管":"Also take one opportunity",
 "合格候选进入已选模拟模式；私有复核最多":"Qualified candidates use the chosen simulation mode. Private check: up to ",
 "积分。":"credits.",
 "可以先开启研究，待策略核验通过后再接管机会。":"Start research now; take opportunities after strategy validation passes.",
 "研究小组先形成证据结论。选中一条发现，再决定补证据、核验策略或继续等待。":"Research teams form evidence-based findings. Select one to inspect, validate a strategy or keep watching.",
 "从研究合同选择策略，复制为个人版本后配置限额、完成交互演练，再用于合格机会。":"Choose a research contract, make a personal version, set limits and rehearse the workflow before using a qualified opportunity.",
 "行情、资金与结构放在同一观察窗口。选定标的后，送入协作核心交叉核验。":"View prices, flows and structure together. Send a selected market to the collaboration core for cross-checking.",
 "从发现到核验，每条线索都有来源、角色和处置依据。转账事实不等于交易意图。":"Every lead has a source, owner and assessment. A transfer does not establish trading intent.",
 "把事件时间、传播强度与核验状态放在一起，先确认事实，再交给 Agent 研究。":"Compare event timing, reach and verification status before assigning a lead to an agent.",
 "一处查看当前实例、待处理信号、模拟委托和持仓。运行状态与协作台共用同一账本。":"See the current run, pending signals, simulated orders and holdings in one ledger shared with the workspace.",
 "管理示例连接、数据覆盖、通知与本地档案。这里不接收真实 API Key 或钱包私钥。":"Manage demo connections, data coverage, notifications and local archives. No real API keys or private keys are accepted.",
 "暂无新的执行事件":"No new execution events",
 "当前没有模拟持仓。":"No simulated holdings.",
 "当前没有待确认信号。":"No signals awaiting confirmation.",
 "研究中":"Researching",
 "可处理候选":"Qualified candidates",
 "需补查或继续等待":"Requires more evidence or time",
 "待处理信号":"Pending signals",
 "逐笔或自主模拟":"Per-order confirmation or autonomous simulation",
 "证据矩阵":"Evidence matrix",
 "当前处置":"Current assessment",
 "查看完整证据":"View all evidence",
 "查看完整规则":"View the full rules",
 "选择策略":"Choose strategy",
 "现货演练":"Spot rehearsal",
 "研究专用":"Research only",
 "形成条件":"Trigger conditions",
 "风险边界":"Risk limits",
 "实施状态":"Implementation status",
 "本浏览器模拟账本最多保留最近 30 单和 40 条事件。":"The local browser ledger retains up to 30 orders and 40 events.",
 "每条委托都能追溯到运行、成交与费用。本浏览器模拟账本最多保留最近 30 单和 40 条事件。":"Trace every order to its session, fills and fees. The local browser ledger retains up to 30 orders and 40 events.",
 "本地模拟":"Local simulation",
 "策略合同正文保留中文原文，避免替换改变参数含义。":"Strategy contract text stays in the original Chinese so wording changes do not alter parameters.",
 "这些开关只改变本地演示状态，不接收真实密钥或钱包签名。":"These switches only change the local demo. No real keys or wallet signatures are accepted.",
 "核心尚未汇总，不能交给策略执行。":"The core has not finished this review, so it cannot go to strategy execution.",
 "TradFi 目前只研究，不能进入模拟交易。":"TradFi is research only and cannot enter simulated trading.",
 "存在反证，消除分歧前阻断执行。":"Counter-evidence is present. Execution stays blocked until the conflict is resolved.",
 "证据待补，补齐前阻断执行。":"Evidence is incomplete. Execution stays blocked until it is filled in.",
 "结论是继续观察，不形成执行任务。":"The conclusion is to keep watching. It does not create an execution task.",
 "这是共享背景，不能单独放行交易。":"This is shared context and cannot authorize a trade by itself.",
 "该结论不能单独放行模拟交易。":"This conclusion cannot authorize a simulated trade by itself.",
 "分歧 / 待补":"Conflict / missing",
 "指标定义":"Definition",
 "来源可信度":"Source confidence",
 "覆盖":"Coverage",
 "当前研究范围":"Current research scope",
 "采集、核验或汇总":"Collecting, checking, or summarizing",
 "可交给策略":"Ready for a strategy",
 "已汇总的 Crypto 候选":"Reviewed Crypto candidates",
 "信号不等于发现":"A signal is not a finding",
 "范围内":"In scope",
 "检查与配置":"Review",
 "模拟资源":"Simulated resources",
 "执行未适配":"Execution not adapted",
 "阻断原因":"Why it is blocked",
 "查看协作现场":"Open workspace",
 "选中一条研究。进行中的任务可回协作台；只有汇总完成的 Crypto 候选才能交给策略。":"Select one study. In-progress work returns to the workspace. Only a finished Crypto candidate can go to a strategy.",
 "可交接的 Crypto 候选排在前面。未汇总、TradFi、分歧和待补不能进入模拟交易。":"Crypto candidates that can be handed off are listed first. Unfinished reviews, TradFi, conflicts, and missing evidence cannot enter simulated trading.",
 "汇总已完成。选择策略后进入个人版本；未确认不生成模拟委托。":"The review is complete. Choosing a strategy opens a personal version. Without confirmation, no simulated order is created.",
 "尚未汇总":"Not summarized",
 "核心汇总完成前，不能交给策略。":"It cannot go to a strategy before the core finishes the summary.",
 "不能执行":"Cannot execute",
 "查看证据":"View evidence",
 "先看形成条件和风险边界，再复制成个人版本。未适配的不能创建现货委托，不展示胜率。":"Read the setup and risk limits, then copy a personal version. Unadapted contracts cannot create spot orders. No win rate is shown.",
 "复制为个人版本。演练通过后才能用于机会。合同正文保留中文。":"Copy a personal version. It can be used on an opportunity only after the rehearsal passes. The contract stays in Chinese.",
 "执行未适配。可以阅读和复制，不能创建现货委托。":"Execution is not adapted. It can be read and copied, but it cannot create a spot order.",
 "核对条件":"Check conditions",
 "复制个人版":"Copy a personal version",
 "演练后使用":"Use after rehearsal",
 "待确认信号、模拟委托和持仓使用同一账本。未确认不生成新委托。":"Signals awaiting confirmation, simulated orders, and holdings share one ledger. Without confirmation, no new order is created.",
 "回执未知":"Receipt unknown",
 "查清前不开启新的模拟风险，也不计为零成交。":"Until it is checked, no new simulated risk opens, and it is not counted as a zero fill.",
 "待确认":"Awaiting confirmation",
 "确认后生成这一笔模拟委托。跳过不生成委托。":"Confirmation creates this simulated order. Skipping creates none.",
 "无待确认信号":"No signal awaiting confirmation",
 "实例运行中":"Run in progress",
 "按已授权剧本执行，到达上限后暂停。":"It follows the authorized script and pauses at the limit.",
 "出现待确认信号后在此处理。未确认不生成新委托。":"A signal is handled here when it needs confirmation. Without confirmation, no new order is created.",
 "未启动":"Not started",
 "尚无模拟实例":"No simulated run",
 "从已汇总的 Crypto 候选选择策略，演练通过后开启。":"Choose a strategy from a summarized Crypto candidate. The run starts after the rehearsal passes.",
 "演练通过":"Rehearsal passed",
 "确认后接管当前合格机会。未确认不启动模拟实例。":"Confirmation takes the current qualified opportunity. Without confirmation, no simulated run starts.",
 "需重新演练":"Rehearsal required again",
 "不能接管":"Cannot take over",
 "风险版本或执行适配已变化。新演练通过前不能接管。":"The risk version or execution fit changed. It cannot take over until a new rehearsal passes.",
 "演练未通过":"Rehearsal not passed",
 "演练通过后才能用于机会。":"It can be used on an opportunity only after the rehearsal passes.",
 "先对账":"Reconcile first",
 "先看形成条件和风险边界，再复制成个人版本。未适配的策略不能创建现货委托，这里不展示胜率或收益。":"Read the trigger and risk limits, then copy a personal version. Unadapted strategies cannot create spot orders. No win rate or return is shown.",
 "可复制后做前端现货演练。真实指标、历史回测与交易引擎均未接入。":"Copy it to rehearse a spot workflow in the interface. Real indicators, historical backtests, and a trading engine are not connected.",
 "执行未适配。可以阅读和复制研究合同，不能创建普通现货委托。":"Execution is not adapted. You can read and copy the research contract, but not create an ordinary spot order.",
 "执行未适配。可演练研究和阻断，不能创建普通现货订单。":"Execution is not adapted. Research and blocking can be rehearsed. Ordinary spot orders cannot be created.",
 "换个筛选，或回到协作台看小组正在采集的资料。":"Change the filter, or return to the workspace to see what the teams are collecting.",
 "没有符合当前筛选的发现。":"No findings match this filter.",
 "这一组还在排队，证据维度会在采集开始后写入同一任务。":"This team is still queued. Evidence appears on the same task once collection starts.",
 "同一研究版本 · 本地模拟":"Same research version · local simulation",
 "采集开始后出现":"Appears when collection starts",
 "按资源逐项检查。每一项都是模拟连接，这里不能填写真实密钥或钱包私钥。":"Check each resource. Every connection is simulated. Real API keys and wallet private keys are not accepted here.",
 "模拟连接，不接收 API Key":"Simulated connection. No API key is accepted.",
 "本地样例，不请求外部接口":"Local fixtures. No external API request.",
 "18 个角色 · 规则剧本":"18 roles · scripted rules",
 "无真实推理，不保存密钥":"No live model call, and no key is stored.",
 "未读取地址，也不发起签名":"No address is read and no signature is requested.",
 "开关只改变演示状态":"The switch only changes the demo state.",
 "站内信号、委托与风险回报":"In-app signals, orders, and risk updates",
 "关闭页面后不继续推送":"Closing the page stops further alerts.",
 "尚未接入":"Not connected yet",
 "登录与多用户":"Sign-in and multiple users",
 "当前是单用户本地模拟":"This is a single-user local simulation.",
 "外部行情":"External prices",
 "接口预留；页面数据仍是固定样例":"An interface is reserved. The page still uses fixed fixtures.",
 "不连接 Nautilus、交易所或链上网络。":"Nautilus, exchanges, and on-chain networks are not connected.",
 "未开放密钥接收、共享或奖励。":"Key intake, sharing, and rewards are not open.",
 "本地档案":"Local archive",
 "收盘样本":"Close samples",
 "当前周期 60 根合成 K 线":"60 synthetic candles in the current window",
 "本地样例":"Local fixture",
 "示例净流入":"Sample net inflow",
 "固定资金切片":"Fixed flow slice",
 "合成 · 非交易所":"Synthetic · not an exchange",
 "窗口内示例净流":"Sample net flow in this window",
 "与行情同一时间窗":"Same window as the price series",
 "示例成交额":"Sample traded value",
 "同一时间窗的合成量":"Synthetic volume in the same window",
 "板块相对变化":"Relative sector change",
 "四类合成板块":"Four synthetic sectors",
 "合成 · 非全市场":"Synthetic · not the full market",
 "示例比率":"Sample ratio",
 "仅 Crypto 样例":"Crypto fixtures only",
 "合成 · 非市值数据":"Synthetic · not a market-cap feed",
 "示例持仓成本带":"Sample cost band",
 "合成 · 非真实成本":"Synthetic · not a real cost",
 "示例净流向":"Sample net flow",
 "仅 Crypto 样例；转账不等于意图":"Crypto fixtures only. A transfer is not intent.",
 "合成 · 旁证":"Synthetic · context only",
 "参数一改就生成新版本。旧演练随之失效；正在运行的实例仍用已锁定的配置。":"Changing a parameter creates a new version and retires the old rehearsal. A running instance keeps its locked configuration.",
 "检查流程、缺项和积分预留。通过只表示交互演练完成，不表示历史收益。":"This checks the workflow, missing data, and credit reserves. Passing means the rehearsal finished, not that there is a historical return.",
 "当前实例、待确认信号、模拟委托和持仓使用同一账本。未知回执先对账，不能当成零成交。":"The current run, signals awaiting confirmation, simulated orders, and holdings share one ledger. An unknown receipt must be reconciled and is not a zero fill.",
 "账户上限和策略额度分开。保存后风险版本加一，旧演练不能放行新实例。":"The account cap and the strategy limit are separate. Saving creates a new risk version. An old rehearsal cannot start a new run.",
 "预留、结算和释放分开记。预算为 0 时停止新的付费研究，已有持仓仍可退出。":"Reserves, charges, and releases are recorded separately. A zero budget stops new paid research. Existing holdings can still be closed."
}).forEach(([source,target])=>exactOverrides.set(source,target));
Object.assign(englishCopy,{
 'SimulatedExecution':'Simulated execution',
 'Credits与Review':'Credits & review',
 '已Pause':'Paused',
 '运行中':'Running',
 '待启动':'Not started',
 '等待运行Event':'Awaiting runtime events',
 'Research、Execution与Risk的Receipts将按发生Time排列。':'Research, execution and risk events appear in time order.',
 'RetainedContext':'Context retained',
 'ViewAsset reports':'View asset reports',
 '完整Trading logs':'Full trading logs',
 'SpotSimulated':'Simulated spot',
 '策略候选':'Strategy candidate',
 '尚未汇总':'Not summarized',
 '不能执行':'Cannot execute',
 '先对账':'Reconcile first',
 '用于已选机会':'Use on the selected opportunity',
 '不能接管':'Cannot take over',
 '需重新演练':'Rehearsal required again',
 '演练未通过':'Rehearsal not passed',
 '演练通过':'Rehearsal passed',
 '回执未知':'Receipt unknown',
 '待确认':'Awaiting confirmation',
 '无待确认信号':'No signal awaiting confirmation',
 '实例运行中':'Run in progress',
 '未启动':'Not started',
 '尚无模拟实例':'No simulated run',
 '可交给策略':'Ready for a strategy',
 '待裁定':'Needs a ruling',
 '代理不执行':'The agent will not execute'
});
Object.entries({"市场总览": "Overview", "涨跌排行": "Gainers & losers", "市场热力图": "Market heatmap", "交易所": "Exchanges", "合约数据": "Derivatives", "合约持仓": "Open interest", "清算数据": "Liquidations", "多空比": "Long / short", "综合指标": "Market indicators", "涨幅榜": "Top gainers", "持仓涨幅榜": "OI gainers", "多空持仓比": "Long / short positions", "全球资产数据分析": "Global asset dashboard", "RSI 平均值": "Average RSI", "山寨季指数": "Altcoin season index", "中性": "Neutral", "超卖 30": "Oversold 30", "超买 70": "Overbought 70", "比特币季": "Bitcoin season", "山寨币季": "Altcoin season", "BTC 主导": "BTC-led", "BTC 市值占比": "BTC dominance", "恐惧与贪婪": "Fear & greed", "自选资产": "Watchlist", "自定义列": "Columns", "筛选": "Filters", "重置筛选": "Reset filters", "只看上涨": "Gainers only", "最低 24h 成交额": "Min. 24h volume", "选择展示的数据列": "Visible columns", "价格 (24h)": "Price (24h)", "成交额 (24h)": "Volume (24h)", "成交额变化": "Volume change", "持仓 (1h)": "OI (1h)", "持仓 (24h)": "OI (24h)", "清算 (24h)": "Liquidations (24h)", "市值": "Market cap", "每页": "Rows", "上一页": "Previous", "下一页": "Next", "排名": "Rank", "涨跌幅": "Price change", "持仓量": "Open interest", "清算": "Liquidations", "每日资金流": "Daily flows", "资金流明细": "Flow history", "基金总览": "Fund overview", "发行方": "Issuer", "管理规模": "AUM", "管理费": "Fee", "资产管理规模": "Assets under management", "区间累计净流入": "Period net inflow", "最新一日净流入": "Latest net inflow", "日成交额": "Daily volume", "盘口深度": "Order book", "数量": "Size", "累计": "Total", "相关消息": "Related news", "行情图表": "Market chart", "最新收益率": "Latest yield", "最新价格": "Last price", "24h 涨跌": "24h change", "总持仓": "Total OI", "指标目录": "Metric directory", "全部类型": "All types", "单指标": "Single metric", "分组": "Breakdown", "成本估值": "Cost & valuation", "分组显示": "Group metrics", "样本起始": "Sample start", "最新值": "Latest value", "样本分位": "Sample percentile", "区间最高": "Period high", "历史走势": "History", "对数坐标": "Log scale", "查看数据": "View data", "收起数据": "Hide data", "指标说明": "About this metric", "使用时留意": "Considerations", "时间粒度": "Interval", "覆盖区间": "Coverage", "数据来源": "Data source", "每日": "Daily", "追踪变化": "Track changes", "开启变化提醒": "Enable change alert", "关闭变化提醒": "Disable change alert", "地址与实体": "Addresses & entities", "持有人分组": "Holder cohorts", "行为与盈亏": "Activity & profit", "转账活动": "Transfers", "稳定币与质押": "Stablecoins & staking", "手续费与区块": "Fees & blocks", "挖矿": "Mining", "内存池": "Mempool", "支付网络": "Payment network", "流通供应量": "Circulating supply", "非流动供应量": "Illiquid supply", "盈利供应占比": "Supply in profit", "长期持有者供应量": "Long-term holder supply", "短期持有者供应量": "Short-term holder supply", "千枚以上地址余额": "Balance of 1,000+ BTC addresses", "小额地址余额": "Small-address balance", "新增地址数": "New addresses", "非零余额地址数": "Non-zero addresses", "活跃实体数": "Active entities", "已实现市值": "Realized cap", "未实现净盈亏比例": "Net unrealized profit / loss", "长期持有者成本": "Long-term holder cost", "短期持有者成本": "Short-term holder cost", "已花费币量": "Spent volume", "链上已实现盈利": "Realized profit", "链上已实现亏损": "Realized loss", "币天销毁": "Coin days destroyed", "链上转移金额": "Transfer volume", "单笔转账中位数": "Median transfer value", "交易所流入量": "Exchange inflows", "交易所流出量": "Exchange outflows", "交易所 ETH 余额": "ETH exchange balance", "稳定币供应量": "Stablecoin supply", "验证者退出队列": "Validator exit queue", "Gas 均价": "Average gas price", "平均单笔费用": "Average transaction fee", "平均区块大小": "Average block size", "全网算力": "Hash rate", "挖矿难度": "Mining difficulty", "矿工地址余额": "Miner balance", "矿工每日收入": "Daily miner revenue", "待确认交易数": "Pending transactions", "内存池交易大小": "Mempool size", "闪电网络容量": "Lightning capacity", "公开支付通道数": "Public payment channels", "交易所持仓分布": "OI by exchange", "持仓变化": "Position changes", "合约持仓明细": "Open interest breakdown", "交易所资金费率对比": "Funding by exchange", "资金费率对比": "Funding comparison", "最高资金费率": "Highest funding", "最低资金费率": "Lowest funding", "币种清算分布": "Liquidations by asset", "最近大额清算": "Large liquidation events", "多空清算明细": "Long / short liquidations", "总清算": "Total liquidations", "多头清算": "Long liquidations", "空头清算": "Short liquidations", "多头占比": "Long share", "多头": "Long", "空头": "Short", "持仓总额": "Total OI", "市场份额": "Market share", "全部交易所": "All exchanges", "交易所资金": "Exchange flows", "合约交易所对比": "Derivatives exchanges", "全体账户": "All accounts", "资金费率": "Funding rate", "当前": "Current", "1日": "1D", "7日": "7D", "30日": "30D", "持仓加权": "OI-weighted", "统一 8h 周期": "Normalized to 8h", "时间": "Time", "方向": "Side", "金额": "Value", "资产": "Asset", "日期": "Date", "全部日期": "All dates", "情景快讯": "Demo news", "今日焦点": "In focus", "热门快讯": "Trending news", "最新消息": "Latest news", "发现与关注": "Discover & follow", "动态": "Activity", "发现交易员": "Discover traders", "排行榜": "Leaderboard", "90d 区间收益": "90d return", "账户净值": "Account equity", "最大回撤": "Max. drawdown", "交易笔数": "Trades", "胜率": "Win rate", "净值走势": "Equity curve", "交易员排行": "Trader ranking", "交易员": "Trader", "账户概览": "Profile", "关注账户": "Follow account", "最近持仓快照": "Latest position snapshot", "账户占比": "Account share", "最近调整": "Last change", "历史动态": "Activity history", "表现分析": "Performance", "关注与跟随": "Following & copying", "名义持仓": "Position notional", "低回撤": "Lower drawdown", "高回撤": "Higher drawdown", "AI 账户观察": "AI account review", "去设置跟随 →": "Set up copying →", "配置模拟跟随 →": "Set up paper copy →", "查看账户与持仓 →": "Account & positions →", "全部基金": "All funds", "基金": "Fund", "合计 / 百万 USD": "Total / USD million", "加入观察列表": "Add to watchlist", "已加入观察": "Watching", "详情 ↗": "Details ↗", "全部 →": "View all →", "币种": "Asset", "返回快讯": "Back to news", "追踪指标": "Track metric", "正在追踪": "Tracking", "研究观点": "Research notes", "已展示当前筛选的全部消息": "All matching news shown", "开始前确认积分；研究结果会回到 AI 现场。": "Confirm credits before starting. Results will appear in the AI scene.", "样例研判": "Sample analysis", "价格上行，继续比较资金变化": "Price is rising. Compare fund flows.", "价格回落，留意波动放大": "Price is falling. Watch volatility.", "观察到变化，等待更多证据": "A change detected. More evidence needed.", "资金流向出现变化": "Fund flows have changed."}).forEach(([source,target])=>{exactOverrides.set(source,target);translations.set(source,target);});
Object.entries({"搜索资产": "Search assets", "多头 / 空头分别统计": "Longs and shorts tracked separately", "涨幅排行": "Top gainers", "跌幅排行": "Top losers", "持仓增长排行": "OI increases", "持仓减少排行": "OI decreases", "每页": "Rows", "90d 趋势": "90d trend", "样本起始": "Sample start", "全部指标": "All metrics", "链上指标目录": "On-chain directory", "价格对照": "Price comparison", "1d 变化": "1d change", "7d 变化": "7d change", "30d 变化": "30d change"}).forEach(([source,target])=>{exactOverrides.set(source,target);translations.set(source,target);});
Object.entries({
 '先看已汇总机会，再查看策略生成的信号与执行结果。':'Review discoveries, then follow strategy signals and simulated trades.',
 '管理运行策略':'Manage strategies',
 '研究发现':'Research discoveries',
 '值得关注':'Watch',
 '存在分歧':'Conflicting evidence',
 '证据待补':'More evidence needed',
 '市场背景':'Market context',
 '同一研究版本 · 本地模拟':'Same research version · Local simulation',
 '机会已汇总':'Review complete',
 '运行中的策略将根据配置与风险条件判断是否执行。':'Running strategies check their saved rules and risk limits before any simulated trade.',
 '小组还在整理信息，暂时不用操作。':'The team is reviewing its findings. No action is needed yet.',
 '暂不交易':'No trade for now',
 '查看运行策略':'View running strategies',
 '发现状态':'Discovery status',
 '研究进度':'Research progress',
 '采集中':'Collecting',
 '已采集':'Collected',
 '换个筛选，或回到协作台看小组正在采集的资料。':'Try another filter or visit the AI scene to see what the teams are researching.',
 '这一组还在排队，证据会在采集开始后写入。':'This team is queued. Evidence appears when collection begins.',
 '没有符合当前筛选的发现。':'No discoveries match this filter.',
 '信号由已启动的模拟实例产生；发现本身不等于订单。':'Signals come from running simulations. A discovery alone does not create an order.',
 '模拟实例启动后，信号会在这里与执行记录对应。':'Start a simulation to see signals linked to their trade records here.',
 '完整执行记录':'Full trade records',
 '处理状态':'Status',
 '去向':'Destination'
}).forEach(([source,target])=>{exactOverrides.set(source,target);translations.set(source,target);});
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
Object.entries({"涨跌榜": "Movers", "热力图": "Heatmap", "涨幅": "Gainers", "跌幅": "Losers", "持仓增长": "OI gainers", "持仓减少": "OI losers", "价格榜": "Price movers", "持仓榜": "OI movers", "最低持仓": "Min. open interest", "价格变化": "Price change", "全部涨跌": "All changes", "上涨 > 5%": "Up > 5%", "下跌 > 5%": "Down > 5%", "显示字段": "Visible fields", "选择数据列": "Select columns", "恢复默认": "Reset defaults", "行情": "Market", "成交": "Volume", "合约": "Derivatives", "本地模拟快照 · UTC+8。所有行情均为演示数据。": "Local snapshot in UTC+8. All market data is simulated.", "本地模拟快照 · UTC+8。行情、消息和账户均为演示数据；不会调用 AI 或提交交易。": "Local snapshot in UTC+8. Market data, news and accounts are simulated. No model calls or orders.", "总览": "Overview"}).forEach(([k,v])=>{exactOverrides.set(k,v);translations.set(k,v);});
Object.entries({'选择策略并交接':'Choose a strategy & hand off','自动找机会':'Find opportunities','开启机会跟进':'Enable opportunity follow-up','研究这个市场':'Research this market','最多使用 / USDT':'Allocation limit / USDT','配置执行方式与限额，开启机会跟进。':'Set the mode and limits, then enable opportunity follow-up.','启动前账户检查：最多 4 体验积分 · ':'Account check on start: up to 4 demo credits · '}).forEach(([k,v])=>{exactOverrides.set(k,v);translations.set(k,v);});
let dictionaryPattern=null;const extraKeys=Object.keys(englishCopy).sort((a,b)=>b.length-a.length);const extraPattern=new RegExp(extraKeys.map(esc).join('|'),'g');
function legacyEnglish(text,locale='en'){
 if(locale!=='en'||!text||!/[\u3400-\u9fff]/.test(text))return text;
 const assetCopy=translateAssetText(text);if(assetCopy!==null)return assetCopy;
 const dynamic=[[/^价格走势，(\d+)个数据点，起点(.+)，终点(.+)$/,(_,count,start,end)=>`Price trend: ${count} points, ${start} to ${end}`],[/^(.+)，左右方向键查看数据$/,(_,name)=>`${translate(name)}: use left and right arrows to inspect`],[/^(.+)窗口起点$/,(_,name)=>`${translate(name)} window start`],[/^(.+)窗口终点$/,(_,name)=>`${translate(name)} window end`],[/^平移(.+)时间窗口$/,(_,name)=>`Pan ${translate(name)} time window`],[/^(.+) K线$/,(_,name)=>`${name} candles`]];for(const [pattern,render] of dynamic)if(pattern.test(text))return text.replace(pattern,render);
 if(exactOverrides.has(text.trim()))return text.replace(text.trim(),exactOverrides.get(text.trim()));
 if(translations.has(text.trim()))return text.replace(text.trim(),translations.get(text.trim()));
 dictionaryPattern??=new RegExp([...translations.keys()].sort((a,b)=>b.length-a.length).map(esc).join('|'),'g');
 const first=text.replace(dictionaryPattern,key=>translations.get(key));return englishCopy[first]||first.replace(extraPattern,key=>englishCopy[key]);
}
export {LOCALES,normalizeLocale,localeInfo};
const catalog=createMessageCatalog([...messages,
 ['任务接入','Intake'],['数据采集','Collect'],['交叉核验','Verify'],['证据汇聚','Merge'],['核心判断','Review'],['结果分流','Route'],
 ['角色接入 {p0}','Connected {p0}'],['输入可用 {p0}','Available {p0}'],['输入已核验 {p0}','Verified {p0}'],['等待汇聚 {p0}','Pending {p0}'],
 ['正在研判 {p0}','Reviewing {p0}'],['判断已完成 {p0}','Reviewed {p0}'],['已分流 {p0}','Routed {p0}'],
 ['已分流 {p0} · 候选 {p1} · 观察 {p2} · 复核 {p3}','Routed {p0} · Candidates {p1} · Watching {p2} · Review {p3}']
]);
const loaders={ja:()=>import('./locales/ja.mjs'),ko:()=>import('./locales/ko.mjs'),vi:()=>import('./locales/vi.mjs'),es:()=>import('./locales/es.mjs'),fr:()=>import('./locales/fr.mjs'),ru:()=>import('./locales/ru.mjs')};
const loading=new Map();
export async function loadLocale(value){
 const locale=normalizeLocale(value);if(!loaders[locale]||catalog.has(locale))return locale;
 if(!loading.has(locale))loading.set(locale,loaders[locale]().then(module=>{catalog.register(locale,module.default);return locale;}).catch(error=>{loading.delete(locale);throw error;}));
 return loading.get(locale);
}
let language='en',forcedLocale=null;try{const wanted=new URLSearchParams(globalThis.location?.search||'').get('lang')?.toLowerCase().split('-')[0];language=normalizeLocale((LOCALES.some(item=>item.id===wanted)?wanted:null)||globalThis.localStorage?.getItem('hive.locale')||'en');}catch{}
export const getLocale=()=>language;
let initialLoadFailed=false;
export const localeReady=loadLocale(language).catch(()=>{language='en';initialLoadFailed=true;});
// Display vocabulary only: saved filter IDs and followed/favorite records keep their identities.
const trackingLanguages={zh:0,en:1,ja:2,ko:3,vi:4,es:5,fr:6,ru:7};
const trackingLabels={
 track:['追踪','Track','追跡','추적','Theo dõi','Seguir','Suivre','Отслеживать'],
 tracked:['已追踪','Tracking','追跡中','추적 중','Đang theo dõi','En seguimiento','Suivi actif','Отслеживается'],
 untrack:['取消追踪','Stop tracking','追跡を解除','추적 해제','Ngừng theo dõi','Dejar de seguir','Arrêter le suivi','Прекратить отслеживание'],
 removed:['已取消追踪','Tracking stopped','追跡を解除しました','추적 해제됨','Đã ngừng theo dõi','Seguimiento cancelado','Suivi arrêté','Отслеживание прекращено'],
 mine:['我的追踪','My tracking','追跡リスト','내 추적 목록','Theo dõi của tôi','Mi seguimiento','Mes suivis','Мои отслеживания'],
 add:['添加追踪','Add tracking','追跡に追加','추적 추가','Thêm theo dõi','Añadir seguimiento','Ajouter un suivi','Добавить отслеживание'],
 accounts:['追踪账户','Tracked accounts','追跡アカウント','추적 계정','Tài khoản theo dõi','Cuentas seguidas','Comptes suivis','Отслеживаемые аккаунты'],
 updates:['追踪动态','Tracked updates','追跡した更新','추적 업데이트','Cập nhật theo dõi','Actualizaciones seguidas','Actualités suivies','Отслеживаемые обновления'],
 trackUpdate:['追踪账户动态','Track account update','アカウント更新を追跡','계정 업데이트 추적','Theo dõi cập nhật tài khoản','Seguir actualización de cuenta','Suivre cette actualité du compte','Отслеживать обновление аккаунта'],
 untrackUpdate:['取消追踪账户动态','Stop tracking account update','アカウント更新の追跡を解除','계정 업데이트 추적 해제','Ngừng theo dõi cập nhật tài khoản','Dejar de seguir esta actualización','Arrêter le suivi de cette actualité','Прекратить отслеживание обновления аккаунта'],
 focus:['追踪信息','Tracking focus','追跡する情報','추적 정보','Thông tin theo dõi','Información seguida','Informations suivies','Отслеживаемая информация'],
 count:['个追踪账户','tracked accounts','追跡アカウント','개 추적 계정','tài khoản theo dõi','cuentas seguidas','comptes suivis','отслеживаемых аккаунтов'],
 empty:['还没有追踪资产','No tracked assets yet','追跡中の資産はありません','추적 중인 자산이 없습니다','Chưa có tài sản theo dõi','Aún no sigues activos','Aucun actif suivi','Пока нет отслеживаемых активов'],
 emptyAccounts:['追踪账户后，在这里查看动态。','Track accounts to see their activity here.','アカウントを追跡すると、ここに更新が表示されます。','계정을 추적하면 여기에서 활동을 볼 수 있습니다.','Theo dõi tài khoản để xem hoạt động tại đây.','Sigue cuentas para ver aquí su actividad.','Suivez des comptes pour voir leur activité ici.','Отслеживайте аккаунты, чтобы видеть их активность здесь.'],
 emptySignals:['追踪感兴趣的资产，集中查看信息和方案。','Track assets to collect their information and plans here.','資産を追跡して、情報とプランをまとめて確認できます。','자산을 추적해 정보와 계획을 모아 보세요.','Theo dõi tài sản để xem thông tin và kế hoạch tại đây.','Sigue activos para reunir aquí su información y planes.','Suivez des actifs pour retrouver ici leurs informations et plans.','Отслеживайте активы, чтобы собирать здесь информацию и планы.'],
 emptyLeads:['追踪线索后，在这里查看后续变化。','Track a lead to see its updates here.','情報を追跡すると、ここで更新を確認できます。','단서를 추적해 여기에서 후속 변화를 확인하세요.','Theo dõi thông tin để xem cập nhật tại đây.','Sigue una señal para ver aquí sus novedades.','Suivez une piste pour voir ici ses mises à jour.','Отслеживайте сигнал, чтобы видеть здесь его обновления.'],
 addHint:['从下方或 AI 信号添加追踪标的','Add tracked assets below or from AI Signals','下の一覧またはAIシグナルから追跡資産を追加','아래 또는 AI 신호에서 추적 자산 추가','Thêm tài sản theo dõi bên dưới hoặc từ Tín hiệu AI','Añade activos desde aquí o desde Señales IA','Ajoutez des actifs ici ou depuis Signaux IA','Добавьте активы ниже или из AI-сигналов'],
 researchHint:['持续研究追踪标的，交易按已启用的策略和额度执行','Research tracked assets. Trading follows enabled strategies and limits.','追跡資産を継続調査し、有効な戦略と上限に従って取引します。','추적 자산을 계속 연구하며 활성 전략과 한도에 따라 거래합니다.','Nghiên cứu tài sản theo dõi; giao dịch theo chiến lược và hạn mức đã bật.','Investiga los activos seguidos; las operaciones respetan las estrategias y límites activos.','Étudiez les actifs suivis ; les opérations respectent les stratégies et limites actives.','Анализ отслеживаемых активов; торговля следует включённым стратегиям и лимитам.'],
 full:['最多追踪200个资产，请先移除一些','You can track up to 200 assets. Remove an asset first.','追跡できる資産は200件までです。先に一部を解除してください。','최대 200개 자산을 추적할 수 있습니다. 먼저 일부를 해제하세요.','Có thể theo dõi tối đa 200 tài sản. Hãy bỏ bớt trước.','Puedes seguir hasta 200 activos. Elimina alguno primero.','Vous pouvez suivre 200 actifs au maximum. Retirez-en un d’abord.','Можно отслеживать до 200 активов. Сначала удалите один.']
};
const trackingAliases=new Map(Object.entries({
 '关注':'track','收藏':'track','追踪':'track','收藏消息':'track','收藏账户变化':'trackUpdate','加入自选':'track','自选':'mine',
 '已关注':'tracked','已收藏':'tracked','已加入自选':'tracked','已追踪':'tracked','正在追踪':'tracked',
 '取消关注':'untrack','取消收藏':'untrack','取消追踪':'untrack','取消收藏账户变化':'untrackUpdate',
 '已移出自选':'removed','已取消追踪':'removed','我的关注':'mine','我的自选':'mine','我的追踪':'mine',
 '添加自选':'add','添加关注':'add','添加追踪':'add','添加我关注的标的':'add',
 '关注这些账户':'accounts','追踪账户':'accounts','追踪动态':'updates','关注信息':'focus','追踪信息':'focus','个已关注账户':'count',
 '还没有关注的资产':'empty','还没有自选资产':'empty','还没有追踪资产':'empty',
 '先关注交易员，再集中查看他们的动态。':'emptyAccounts',
 '关注感兴趣的资产，在这里集中查看信息和方案。':'emptySignals',
 '关注一条线索，后续变化集中在这里查看。':'emptyLeads',
 '从下方添加，也可以在 AI 信号中关注感兴趣的标的':'addHint',
 '持续研究你关注的标的，交易按已启用的策略和额度执行':'researchHint',
 '自选最多保存 200 个，请先移除一些':'full'
}));
function trackingCopy(text,locale){
 if(typeof text!=='string')return null;
 const [,prefix,value,suffix]=text.match(/^(\s*[+☆★]?\s*)([\s\S]*?)(\s*)$/u);
 const key=trackingAliases.get(value);
 if(key)return prefix+trackingLabels[key][trackingLanguages[locale]]+suffix;
 const asset=value.match(/^(取消收藏|取消关注|取消追踪|收藏|关注|追踪) ([A-Za-z0-9._:/-]+)$/u);
 return asset?prefix+trackingLabels[asset[1].startsWith('取消')?'untrack':'track'][trackingLanguages[locale]]+' '+asset[2]+suffix:null;
}
const productLabelAliases=new Map([
 ['AI 交易','AI 星谱'],['星谱','AI 星谱'],['AI 交易记录','星谱交易记录'],
 ['AI 交易盈亏','星谱盈亏'],['返回 AI 交易','返回 AI 星谱']
]);
function translateMessage(text,locale='en'){
 locale=normalizeLocale(locale);
 if(locale!=='zh'&&productLabelAliases.has(text))text=productLabelAliases.get(text);
 const tracking=trackingCopy(text,locale);if(tracking!==null)return tracking;
 if(locale==='zh'||typeof text!=='string'||!text)return text;
 const dataLead=text.match(/^(.*?)(数据中心线索：)(.+)$/u);if(dataLead)return translate(dataLead[1],locale)+translate(dataLead[2],locale)+' '+translate(dataLead[3],locale);
 const decorated=text.match(/^(.*?)(\s+[↕↑↓])$/u);if(decorated){const label=catalog.resolve(decorated[1],locale);if(label!==null)return label+decorated[2];}
 const exact=catalog.resolve(text,locale);if(exact!==null)return exact;
 const badge=text.match(/^([\p{P}\p{S}\p{M}\s]+)(.+)$/u);if(badge){const label=catalog.resolve(badge[2],locale);if(label!==null)return badge[1]+label;}
 const assetLabel=text.match(/^([A-Z0-9._:-]{1,20}(?:\/[A-Z0-9._:-]{1,20})?\s+)(.+)$/);if(assetLabel){const label=catalog.resolve(assetLabel[2],locale);if(label!==null)return assetLabel[1]+label;}
 // shortcut: old stored event fragments retain their legacy fallback until they have message IDs.
 const legacy=legacyEnglish(text);
 if(legacy!==text&&!/[\u3400-\u9fff]/.test(legacy)){
  if(locale==='en')return legacy;
  const complete=catalog.resolve(legacy,locale);if(complete!==null)return complete;
 }
 const parts=text.split(/(\s[·→|]\s|\s\/\s|[:：]\s)/);
 if(parts.length>1)return parts.map((part,i)=>i%2?part:(catalog.resolve(part,locale)??(locale==='en'?legacyEnglish(part):part))).join('');
 return text;
}
function pairMessage(zh,en,locale=language){
 locale=normalizeLocale(locale);const tracking=trackingCopy(zh,locale);if(tracking!==null)return tracking;
 if(locale==='zh')return zh;if(locale==='en')return en;
 const rendered=translate(en,locale);
 // Some legacy renderers choose English labels from objects; the Chinese message still identifies them.
 return rendered===en?(catalog.resolve(zh,locale)??rendered):rendered;
}

const productNames={
 zh:['AI 交易','智选信号'],en:['LensWave','Smart Signals'],ja:['AI スペクトラム','スマートシグナル'],ko:['AI 스펙트럼','스마트 시그널'],vi:['Phổ AI','Tín hiệu thông minh'],es:['Espectro IA','Señales inteligentes'],fr:['Spectre IA','Signaux intelligents'],ru:['Спектр ИИ','Умные сигналы']
};
const priorProductNames=[['AI 星谱','AI星谱','AI 战队','AI team','AI Spectrum','AI チーム','AI 팀','Đội AI','Equipo de IA','Équipe IA','Команда ИИ'],['AI 信号','AI信号','AI signals','AI Signals','AIシグナル','AI シグナル','AI 신호','Tín hiệu AI','AI Tín hiệu','Señales IA','AI Señales','Signaux IA','AI Signaux','Сигналы ИИ','AI Сигналы']];
const productNamePatterns=priorProductNames.map((names,index)=>new RegExp([...new Set([...names,...Object.values(productNames).map(row=>row[index]).filter(name=>name!=='AI 交易')])].sort((a,b)=>b.length-a.length).join('|'),'g'));
function productCopy(text,locale){
 if(typeof text!=='string')return text;
 const target=normalizeLocale(locale);
 // Localize only known labels. Keep ordinary phrases such as “AI 交易策略” intact.
 if(target==='zh')text=text.replace(/(?:AI\s*)?星谱交易记录/g,'AI 交易记录').replace(/星谱盈亏/g,'AI 交易盈亏').replace(/^星谱$/,'AI 交易');
 const value=productNamePatterns.reduce((value,pattern,index)=>value.replace(pattern,productNames[normalizeLocale(locale)][index]),text);
 return presentationCopy(normalizeLocale(locale)==='en'?value.replace(/Spectrum trade history/g,'LensWave trade history').replace(/Spectrum P&L/g,'LensWave P&L').replace(/Runtime spectrum/g,'LensWave runtime'):value);
}
export function translate(text,locale='en'){return productCopy(translateMessage(text,locale),locale);}
export function pair(zh,en,locale=forcedLocale||language){return productCopy(pairMessage(zh,en,locale),locale);}
export function withLocale(locale,fn){const previous=language;language=normalizeLocale(locale);try{return fn();}finally{language=previous;}}
export function forceLocale(locale,fn){const previous=forcedLocale;forcedLocale=locale?normalizeLocale(locale):null;try{return fn();}finally{forcedLocale=previous;}}
export const t=text=>translate(text,language);
export function initLocale(){
 const originals=new WeakMap(),attributes=new WeakMap();let timer=null,request=0;
 const ignored=n=>n.parentElement?.closest('script,style,textarea,code,pre,[data-no-translate],.reactor-courier-layer,.chat-user');
 function textNode(n){if(ignored(n))return;const previous=originals.get(n);const original=previous&&n.data===previous.rendered?previous.original:n.data;const rendered=n.parentElement?.closest('option,.commerce-flow')?t(original):presentationCopy(t(original));if(n.data!==rendered)n.data=rendered;originals.set(n,{original,rendered});}
 function localize(root){
  if(root.nodeType===3){textNode(root);return;}if(root.nodeType!==1&&root!==document.body)return;
  if(root.closest?.('script,style,textarea,[data-no-translate],.reactor-courier-layer'))return;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode())textNode(n);
  for(const el of [root,...root.querySelectorAll('[title],[aria-label],[placeholder]')]){
   if(el.closest?.('[data-no-translate],.reactor-courier-layer'))continue;
   const record=attributes.get(el)||{};
   for(const key of ['title','aria-label','placeholder'])if(el.hasAttribute?.(key)){
    const value=el.getAttribute(key),old=record[key],original=old&&old.rendered===value?old.original:value;
    const label=key==='aria-label'&&original==='Close'&&el.matches?.('[data-rk][role=dialog] button')?pair('关闭','Close'):t(original);
    const rendered=el.closest('.commerce-flow')?label:presentationCopy(label);
    if(value!==rendered)el.setAttribute(key,rendered);
    record[key]={original,rendered};
   }
   attributes.set(el,record);
  }
 }
 const dirty=new Set();const observer=new MutationObserver(records=>{
  for(const r of records){if(r.target.parentElement?.closest('.reactor-courier-layer')||r.target.closest?.('.reactor-courier-layer'))continue;
   if(r.type==='characterData'||r.type==='attributes')dirty.add(r.target);else for(const n of r.addedNodes)dirty.add(n);
  }
  if(dirty.size&&!timer){timer=true;queueMicrotask(flush);}
 });
 function flush(){timer=null;observer.disconnect();for(const n of dirty)if(n.isConnected)localize(n);dirty.clear();observe();}
 function observe(){observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','placeholder']});}
 const picker=document.querySelector('.language-picker'),status=document.querySelector('.language-status');
 function syncPicker(){
  const info=localeInfo(language);document.documentElement.lang=info.tag;document.documentElement.dataset.locale=language;
  document.querySelector('.reactor-courier-layer')?.setAttribute('aria-label',t('Agent 数据采集与交接'));
  document.documentElement.style.setProperty('--collector-caption',JSON.stringify(pair('采集','Collecting')));
  for(const b of document.querySelectorAll('button[data-locale]'))b.setAttribute('aria-pressed',String(b.dataset.locale===language));
  const code=document.querySelector('[data-language-code]');if(code)code.textContent=info.short;
  picker?.querySelector('summary')?.setAttribute('aria-label',pair('选择语言','Language'));
  picker?.querySelector('.language-options')?.setAttribute('aria-label',pair('选择语言','Language'));
 }
 async function set(value){
  const id=++request,next=normalizeLocale(value);picker?.setAttribute('aria-busy','true');
  try{await loadLocale(next);if(id!==request)return;language=next;try{localStorage.setItem('hive.locale',language);}catch{}
   if(document.querySelector('.product-nav')){const url=new URL(location.href);if(language==='en')url.searchParams.delete('lang');else url.searchParams.set('lang',language);history.replaceState(history.state,'',url);}
   observer.disconnect();syncPicker();localize(document.body);observe();document.dispatchEvent(new CustomEvent('hive:locale',{detail:{locale:language}}));if(status)status.textContent='';if(picker)picker.open=false;
  }catch{if(status)status.textContent=pair('语言加载失败，请重试。','Could not load this language. Please try again.');}
  finally{if(id===request)picker?.removeAttribute('aria-busy');}
 }
 for(const b of document.querySelectorAll('button[data-locale]'))b.onclick=()=>set(b.dataset.locale);
 document.addEventListener('change',event=>{if(event.target.matches('select[data-language-select]'))set(event.target.value);});
 document.addEventListener('pointerdown',event=>{if(picker&&!picker.contains(event.target))picker.open=false;});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&picker?.open){picker.open=false;picker.querySelector('summary').focus();}});
 syncPicker();localize(document.body);if(initialLoadFailed&&status)status.textContent='Could not load this language. Please try again.';observe();return {set,get language(){return language;}};
}
