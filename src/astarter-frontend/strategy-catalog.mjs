// Research catalog; no claim of implemented strategy or backtest.
export const CATALOG=[
  {
    "id": "S00",
    "name": "H5 多周期结构/PA/能量/点位",
    "market": "BTCUSDT SPOT，长仓/空仓",
    "timeframe": "15m触发，1h中轴，4h环境",
    "setup": "冻结15m/1h/4h关系；1h和4h EMA20>EMA50。H5四项评分T≥80、P≥60、E≥40、L≥70且总分≥250；评分必须有当时证据/作者/版本/available_at，接受后有效2h。原表没有可校准评分函数，本版把评分当审阅输入，不在历史图上事后补分。",
    "entry": "评分首次合格时冻结前12根完整15m high最大H0；之后2h内新close上穿H0，且close>1h EMA20、0.001≤1h ATR14/close≤0.03。signal close+10s内，stop<ask≤cap、所需数据/日历/预算通过才一次IOC；一个评分episode最多一次提交。",
    "exit": "stop=floor_tick(min(最近3根完整15m low)-0.25*1h ATR)，0<D≤3*1h ATR；目标3D。B为成交后2根15m close≤H0或经过24个1h边界；趋势EMA失效按预批风险政策退出。没有日志/数据停新风险，保留可证退出。",
    "risk": "r≤0.25%、名义≤10%；按统一含费压力公式。自动加仓关闭；2R移stop/3R加仓若采用必须另建版本，不能默认为H5全都打开。",
    "data": "两主周期各250根完整bar、15m价格/报价/L2/新闻日历；点时评分日志及指标/形态定义。Vegas或结构线的参数需在评分计划中冻结，不能凭源文件名称猜已实现。",
    "validation": "有当时评分日志才做完整回放；否则先前向影子记录。对照去掉评分的价格突破、仅趋势过滤、完整H5；评分一致性/延迟单列，不从250分推出34%胜率。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "technical",
    "execution": "spot"
  },
  {
    "id": "S01",
    "name": "现货有限买方网格",
    "market": "BTCUSDT SPOT，无预置卖空库存",
    "timeframe": "1h定环境，逐笔挂撤",
    "setup": "每日首次合格1h收盘可建一episode：此前48根形成[L48,H48]，宽度为4–12 ATR，EMA50相对12根前变化绝对值≤1 ATR；当前价在区间中部40%–60%。冻结C0、ATR0与区间，最长24h，未到期不重定中心。",
    "entry": "d=max(0.004*C0,0.5*ATR0)，四个买层p_i=floor_tick(C0-i*d)，i=1..4；全部须在[L48,H48]内。每层同base数量q，用四层全部成交的最坏损失和现金反算q。买用已验证LIMIT GTC/post-only；不支持所需类型则不启用。新建层先原子校验，单层一个唯一活跃意图。",
    "exit": "每层真实已买库存以p_i+d为该层净卖目标，向上tick合法化，含费净价差必须>预批成本缓冲；卖量仅对应已买未卖库存。共同stop=L48-ATR0；突破下界/到24h停补买、撤余买并协调结束库存。上破H48不追；不自动平移网格。",
    "risk": "整篮风险≤0.25%/名义≤10%，不是每层0.25%。四层与所有在途买费/总退出费一次预留；局部卖出后的重复买入也重算总风险。退出/补单冲突由单一库存协调器管理。",
    "data": "原生L2/逐笔、订单/部分成交/队列与品种合同；报价双龄候选≤500ms；新闻120s/日历核对24h。GTC/post-only/撤单/STOP组合待专项验证，不能直接套RX的单IOC合同。",
    "validation": "比较固定风险、原表单元升级与证据阶段；单边下跌穿四层、跳空不反弹、买单取消仍成交、taker化、资金预留及含浮亏权益。每轮利润必须连同库存浮亏/费用报告。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "technical",
    "execution": "research"
  },
  {
    "id": "S02",
    "name": "三层有限马丁/均值回归篮子",
    "market": "BTCUSDT SPOT，仅作为风险受限研究",
    "timeframe": "5m信号，1h环境",
    "setup": "1h EMA20≥EMA50，5m RSI14从≤30上穿30且≤45。冻结signal close参考cap为p0、ATR0及篮子身份；不是任何下跌都补。",
    "entry": "最多三层base数量权重1/1.5/2.25，总4.75。p1=p0-ATR0、p2=p0-2ATR0；共同stop=p0-3ATR0，均先tick合法化。第一层signal+5s内单次IOC，零成交结束；有仓后才在有效ask≤对应层价且>stop时评估后续单次IOC。跳空越过多层只允许评估最深仍合法的一层，其余标SKIPPED，不连续补齐。",
    "exit": "篮子target=当前真实加权均价+0.75ATR0，需覆盖实际费用和预批净缓冲；数量/目标只由真实fill更新，stop不外移。B为12个5m边界或1h环境失效；C为共同stop/硬风险。后续层在60min篮子寿命内有效，过期或任一层状态未知停止追加。",
    "risk": "整篮r≤0.10%、名义≤5%；先按三层全部成交计算q0/现金/压力风险。层失败不提高乘数；亏损结束后不提高下个篮子起始量。首版默认研究关闭。",
    "data": "原生bar/双龄报价/账户/逐层fill与费用、已批层级表、新闻日历。未定义总资金/止损/三层上限就不能建案。",
    "validation": "必须比较单层同信号、等量DCA、固定三层1/1.5/2.25；单边无反弹、跳过层、同时触发/未知、最小订单与费用2倍。只证明有限，不称安全或正期望。",
    "version": "research-v0.1",
    "abc": {
      "A": "已批层条件命中可评估；仍不得超过总预算",
      "B": "停止追加，时间/环境失败协调退出篮子",
      "C": "止损/账户/未知先锁；确定硬风险退出可证库存"
    },
    "kind": "technical",
    "execution": "research"
  },
  {
    "id": "S03",
    "name": "均线＋RSI（冻结原版）",
    "market": "BTCUSDT SPOT，长仓/空仓",
    "timeframe": "5m",
    "setup": "250根连续bar；EMA20>EMA50且close>EMA20；RSI14 Wilder前值≤50、当前>50且≤65；ATR14/close∈[0.001,0.02]。以原v0.1.1完整合同为准。",
    "entry": "新RSI穿越，signal close+5s内；连续PAPER参考新鲜ask，离线参考close。单次LIMIT IOC、允许部分、不追余；机会/账户/费用/授权/风险原子检查。",
    "exit": "stop=signal close-2ATR；原版没有固定止盈/跟踪止盈。B为RSI<45连续两根或首次fill后36个5m边界；C含EMA20≤EMA50、stop、日损等。归零后3根完整5m冷却，再等新穿越。",
    "risk": "原版r=0.5%、名义20%、日损2%；不得被图册默认0.25%/10%悄悄改掉。新capital-overlay候选只能另建版本按min缩小并重验。",
    "data": "完整原S03数据/报价双龄≤2s、新闻健康≤120s、费用/品种、原生保护/恢复能力；来源卡尚有运行门槛，不把既有无状态探针当策略通过。",
    "validation": "沿原卡S03-T01–14；只引用其已观察有限指标/IOC证据，不复述成策略已实现。附加新资管或日历/止盈必须单独版本和对照。",
    "version": "s03-ema-rsi-long-flat@v1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "technical",
    "execution": "spot"
  },
  {
    "id": "S04",
    "name": "缠论启发：确认中枢后三买",
    "market": "BTCUSDT SPOT，简化研究变体",
    "timeframe": "15m",
    "setup": "使用研究稿6.3的确定性5根分型/归约：同根顶底同时成立丢弃，反向中心索引差≥3，否则丢弃；同类只保留更极端。只取最近连续4端点的3段区间交集[ZD,ZG]，ZD<ZG才冻结中枢。不是完整缠论递归定义；有活动中枢episode时不建第二个。",
    "entry": "冻结中枢后24h内，首个确认上离高点H之后有确认回踩低点L>ZG才形成触发窗，H/L在L确认时冻结；出现确认低点<ZD或24h无合格回踩则失效。L确认后12h内新15m close上穿H，close>EMA50、quote额≥前20根中位1.5倍；TTL15s，一结构最多一次IOC。",
    "exit": "stop=L-0.25ATR14且0<D≤3ATR；target2D。B为2根close≤ZG或48个15m边界；结构被新事实撤回仅让未来候选失效，历史决策不可重标。C硬stop/账户风险照合同。",
    "risk": "r≤0.25%、名义≤10%，按全费压力取量；不自动加仓，不让新中枢覆盖旧stop。",
    "data": "完整15m OHLC/成交额、每一分型/端点/中枢版本与确认时刻；QQ/新闻日历。缺结构确认日志不能用最终图回测。",
    "validation": "前缀因果测试（给数据后半段不改前半段信号）；比较纯突破、交集区间过滤、三买；端点相等、连续高点、缺根、晚确认、结构更新。若需正统缠论另冻结更完整定义。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "technical",
    "execution": "spot"
  },
  {
    "id": "S05",
    "name": "日内订单簿剥头皮",
    "market": "BTCUSDT SPOT，微结构专项",
    "timeframe": "L2/逐笔，1s特征",
    "setup": "同一原生成交流与L2序列完整，双龄≤100ms、spread≤2tick。当前bid/ask各20bps深度Qb/Qa；imbalance=(Qb-Qa)/(Qb+Qa)≥0.35持续3次递增更新且跨度≥100ms。最近1s主动成交delta≥0.20且mid较1s前上移≥2tick。",
    "entry": "需预先用该费率/延迟/流动性分层的样本外数据证明条件净优势；没有则WAIT。候选寿命从第三次有效更新起200ms；带cap的IOC，信号不能过期后补做。当前目标价距入场5bps、stop距入场5bps是研究起点，不能凭该目标视作可覆盖费用。",
    "exit": "5bps目标/5bps stop、30s最长持仓；新的卖方失衡≤−0.35且主动delta<0时B退出；丢序/延迟停新增、保留保护/对账。原生订单/触发源/退出能力不明则不启用。",
    "risk": "r≤0.05%、名义≤2%；费用和滑点进入损失预算。在当前通用买卖各0.1%模拟费率下，5bps毛目标小于20bps双腿费，直接被成本门槛否决；不能用更低的假费率制造可用。",
    "data": "同所真实L2/逐笔与maker/taker费用、时钟/序列/回报；队列/隐藏量/撤单必须在重放中说明，不拿K线模拟出L2。",
    "validation": "tick/L2逐事件回放、20/50/100/250ms订单时延，完整净收益/成交率/不利选择/尾部。先解决费用和服务地理位置后再做前向；bar回测不合格。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "technical",
    "execution": "research"
  },
  {
    "id": "S06",
    "name": "波浪启发：确认4浪后的5浪尝试",
    "market": "BTCUSDT SPOT，机械化浪型变体",
    "timeframe": "1h",
    "setup": "使用研究稿6.3的已确认分型归约（改为1h），只取最近连续5端点P0低/P1高/P2低/P3高/P4低；同根双分型丢弃、反向索引差不足3丢弃。P2>P0、P3>P1、P4>P1；P2回撤为波1的[0.382,0.786]，P4回撤为波3的[0.236,0.50]，P3-P2≥P1-P0。只叫特定候选结构，不预判完整艾略特浪型。",
    "entry": "P4确认后24h内新1h close上穿P3，quote额≥前20根中位1.5倍且close>EMA50；TTL30s；端点和映射冻结，一结构最多一次IOC。",
    "exit": "stop=P4-0.25ATR14，0<D≤3ATR；target2D；B为2根close≤P3或72个1h边界。若P4后又跌破P1则未来候选无效，不能改浪计数救持仓；C stop/硬风险。",
    "risk": "r≤0.25%、名义≤10%；多种浪计数不各占一份额度，不以“主升浪”提高风险。",
    "data": "1h价量、确认端点/波段版本、QQ/新闻日历；任何AI浪型标注保留生成时刻，不回填历史。",
    "validation": "对照无浪比率的突破、纯分型、完整约束；ratio阈值邻近敏感性，确认延迟与复杂浪/跳空失败。不能用未来完整5浪筛选今日入场。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "technical",
    "execution": "spot"
  },
  {
    "id": "S07",
    "name": "威科夫价量：Spring＋Test确认",
    "market": "BTCUSDT SPOT，范围内需求假设",
    "timeframe": "1h",
    "setup": "每日首次合格1h收盘冻结前48根[L0,H0]，宽度4–10ATR，EMA50较12根前变化绝对值≤1ATR。Spring bar满足L0-0.5ATR≤low<L0、close>L0、quote额≥前20中位1.5倍。",
    "entry": "Spring后8根内出现Test：low≥L0-0.1ATR且quote额≤Spring的0.8倍、close>L0。冻结Test high，后4根内新close上穿；到时趋势/数据/预算通过才一次IOC，TTL30s；一个区间episode最多一次提交。",
    "exit": "stop=Spring low-0.25ATR；目标H0，只有cap到H0毛距离≥2D且成本检查通过才做。B为2根close≤L0或48个1h边界；C stop/硬风险。阶段标签只解释，不称已观察庄家/主力身份。",
    "risk": "r≤0.25%、名义≤10%；量大并非资金净流入，冲高不加仓。",
    "data": "完整OHLC/quote额、区间/Spring/Test确认日志；主动成交/链上可反证但缺失不伪造；QQ/新闻日历。",
    "validation": "对照简单区间突破、仅Spring、加Test；低流动性假量、假跌破继续下跌、Test晚到、后补区间、交易量口径变化；不能按事后上涨挑“吸筹”。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "technical",
    "execution": "spot"
  },
  {
    "id": "S08",
    "name": "裸K：顺结构Inside Bar突破",
    "market": "BTCUSDT SPOT，长仓/空仓",
    "timeframe": "1h母子K，5m触发",
    "setup": "采用已确认1h分型，最近两高点递升且两低点递升。刚闭合1h子K的high<前一母K high且low>母K low，等号不算。冻结母K高低及episode，有效4h。",
    "entry": "之后新的完整5m close从≤母K high上穿，当前quote额≥前20根5m中位1.2倍；同刻1h结构仍有效。TTL10s，一母K组合最多一次IOC。",
    "exit": "stop=母K low-0.25*1h ATR，0<D≤3*1h ATR；target2D。B为2根5m close≤母K high，或24个5m边界；新出现Inside Bar不能替换旧持仓stop。",
    "risk": "r≤0.25%、名义≤10%；形态只是触发，不能用“裸K直觉”绕过额度/行情和新闻。",
    "data": "两周期闭合OHLC/成交额、1h分型可得时间、母子K身份、QQ/新闻日历；不在1h子K闭合前看最终高低。",
    "validation": "比较无高周期结构、完整结构；包含等高等低、未闭合bar、跨周期时间、假突破/跳空。只定义Inside Bar变体，其他Pin/Fakey后续独立版本。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "technical",
    "execution": "spot"
  },
  {
    "id": "S09-A",
    "name": "同链池间原子套利",
    "market": "Ethereum主网，WETH/USDC双池候选",
    "timeframe": "canonical区块/链事件",
    "setup": "两个准确登记的池/路由/合约与同一canonical state_ref，head_lag≤1块，全部ABI/decimals/手续费/权限有效；缺准确地址或状态不研究“当前可执行套利”。",
    "entry": "仅完整闭环原子路线USDC→WETH→USDC。同一状态仿真的amountOut_net是全部swap/池费/输出税之后最终到账USDC，已经嵌入的费用不再扣；逐项标记included_in_amountOut。净收益=amountOut_net−输入−未嵌入的gas/外部费用−MEV/失败成本缓冲，需≥max(1USDC,输入5bps)。amountOutMin≥输入+这些未嵌入成本+最低净收益，按USDC最小单位向上取整；状态/报价超时不提交。不把跨链/两笔非原子交易并入。",
    "exit": "成功以实际receipt/资产差/费用对账结束；失败计真实gas。未决nonce/receipt进入UNKNOWN，不盲重发。链重组保留撤回关系；不存在持仓止盈2R。",
    "risk": "名义≤5%权益，失败费用预算≤0.10%权益并计入当日预算；同时校验可能残留资产/合约风险。没有原子性证明就否决，不当无风险收益。",
    "data": "准确池状态、swap仿真、canonical/finality、nonce/receipt、native gas与quote转换、所有费/输出税；GeckoTerminal榜单只发现，不能替代执行状态。",
    "validation": "区块/交易顺序回放，包含竞争、前跑/回跑、revert、燃气暴涨/重组/未知回执和可用资本。Nautilus的CEX bar成交不等于EVM原子路线被验证。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "technical",
    "execution": "research"
  },
  {
    "id": "S09-L",
    "name": "集中流动性LP库存管理（新增子版）",
    "market": "指定同链WETH/USDC CLMM池，长库存",
    "timeframe": "1h计划，区块级状态/保护",
    "setup": "准确池/position NFT/资产/decimals/fee/ticks、当时资金/费用/风险和完整历史。拟在1h EMA50斜率绝对值≤0.5ATR（较12根前）且报价风险有效的区间环境研究；这是收手续费和管理库存，不称原子套利。",
    "entry": "首次合格时冻结P0及区间[P0-2ATR,P0+2ATR]，下界>0并按池tick向外合法化；先按真实分段公式计算两币需要量、gas与全额本金风险。只研究一次建仓；余额/仿真/最小净收益与压力门槛通过才可能进入模拟。",
    "exit": "出区间/1h环境失效停止新增，已有LP目标为移除可证流动性并管理两币；固定计划24h到期。出区间可能单边持币且无活跃费，撤流不是自动换成USDC；Swap需另有已批动作/成本，未知receipt不假定撤出。默认不自动重置区间。",
    "risk": "名义上限5%权益只是候选；全部投入以100%损失计入同一个1%组合压力剩额，另扣gas。因此实际最大≤组合剩额，10,000账户常≤100，可能费用不合算而拒绝。不能用停止价假设屏蔽合约/链尾部风险。",
    "data": "同池ticks/active liquidity/fee growth/position/prices/receipt与区块序列；两币独立估值、手续费币种、提取/兑换成本、脱锚和合约风险；不把TVL/费APR当用户净收益。",
    "validation": "按区块/LP公式回放库存与手续费、相同两币HODL及现金对照；LVR/不利选择、区间外时长、重置gas、单边价格崩溃、链停/合约全部损失。必须报告net wealth和风险，不能只列手续费。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "technical",
    "execution": "research"
  },
  {
    "id": "RX01",
    "name": "宏观事件后延续",
    "market": "BTCUSDT SPOT",
    "timeframe": "5m",
    "setup": "BLS CPI/就业实际发布可得时点t0，日历核对≤24h；前三根完整5m形成H0/L0；所有日历禁开窗结束才研究入场。",
    "entry": "t0+120min内range完成后的新cross_up(close,H0)，EMA50与1.5倍成交额确认；ATR/close[0.001,0.02]、spread≤10bps，5s TTL一次IOC。",
    "exit": "stop=min(L0,C-1.5ATR)，D≤3ATR，target2D；B为成交后2根close≤H0或24根5m边界；C按共用RC05。",
    "risk": "r=0.25%上限，名义10%，压力20bps；私人与组合额度可更低。",
    "data": "原始发布/日历/available_at、250根5m、QQ/L2/新闻/账户；发布晚于规定窗口不回填。",
    "validation": "原卡RC07与事件组对照/时间分割，最低30次发布/20次成交/测试10次且跨季度；样本门槛非有效性证明。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "event",
    "execution": "spot"
  },
  {
    "id": "RX02-P",
    "name": "原帖叙事扩散与现货确认",
    "market": "ETHUSDT SPOT",
    "timeframe": "30m原帖窗，15m价格",
    "setup": "原帖/作者/原源去重，过去14d≥95%覆盖。A=U/max(medianU,3)，门槛A≥3、U≥8、G≥3；合格false→true产生6h episode，2窗false且距前t0≥24h才reset。",
    "entry": "t0冻结前12根15m high为H0；新上破、EMA50、成交额2倍；最新合格attention窗结束龄≤35m，TTL10s一次IOC。",
    "exit": "stop=C-2ATR，D≤3ATR，target2D；B两根close≤H0、连续两窗A<1.5或16根15m边界；缺社媒不是低热度。",
    "risk": "r≤0.25%、名义≤10%；传播热不加额度。",
    "data": "原帖字段/采样覆盖/删除/作者及主题版本，不能用聚合情绪或精选帖替代完整原源计数；其余RC核心。",
    "validation": "原卡点时/去重/移位对照，100 episode/50成交/测试20最低报告量；机器人/转载/买量压力，不声称独立作者就全是真人。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "event",
    "execution": "spot"
  },
  {
    "id": "RX02-A",
    "name": "聚合关注与互动异常",
    "market": "ETHUSDT SPOT",
    "timeframe": "1h聚合，15m价格",
    "setup": "同方法1h mentions M/interactions J，14d≥95%覆盖；M≥max(30,3倍历史中位M)、J≥2倍中位J；首个合格false→true，6h episode。",
    "entry": "独立于P的H0/价格确认，最新窗结束龄≤70min且到达≤结束+10min；TTL10s，原帖U/G不混入。",
    "exit": "价格/ATR/stop/target/16根持有同P；热度B是两个相邻合格1h窗M<1.5倍历史中位，不是P的A。",
    "risk": "r≤0.25%、名义≤10%；A/P独立账本与结果。",
    "data": "合格聚合API实际1h字段/覆盖/方法/历史；滚动24h不能拆1h，套餐名称不证明entitlement。",
    "validation": "独立于P对照M/M+J/无社媒，窗口混用/覆盖变化/缺值与时点；100/50/20候选报告量。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "event",
    "execution": "spot"
  },
  {
    "id": "RX03-S",
    "name": "定点池链上成交倾斜",
    "market": "ETHUSDT SPOT；指定Ethereum池输入",
    "timeframe": "30m链窗，15m价格",
    "setup": "准确Uniswap V3 WETH/USDC fee500池待核；30m完整finalized窗，14d基线≥95%。I=(买USDC额-卖USDC额)/总额≥0.20，总额≥2倍中位；false→true建4h episode。",
    "entry": "冻结12根15m H0后新cross、EMA50、成交额1.5倍；链窗结束龄≤60m且当前仍满足；USDC/USDT[0.995,1.005]且≤60s，TTL10s。",
    "exit": "stop=C-2ATR、D≤3ATR、target2D；B两根价格失败、两窗I≤0或16根15m边界；未知不是I=0。",
    "risk": "r≤0.25%、名义≤10%；只在CEX现货执行，不做输入池Swap。",
    "data": "准确池/ABI/decimals/log/receipt/canonical/finality/水位与同交易净额，原始QQ/新闻日历；不称全链净流入。",
    "validation": "原卡局部池对照/可得性，100/50/20候选报告量；循环/套利/重组/失页/结算币异常。不用S替代BTC实体版。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "event",
    "execution": "spot"
  },
  {
    "id": "RX03-B",
    "name": "原生BTC实体净流出异常",
    "market": "BTCUSDT SPOT",
    "timeframe": "日级实体窗，1h价格",
    "setup": "专业实体日级NetIn，连续60日；NetIn<0、robust z≤−2、MAD>0。标签/集合使用当时版本，实际到达≤日窗结束+12h。",
    "entry": "t0冻结前24根1h high，episode到min(t0+24h,window_end+36h)；新cross、EMA50、成交额1.2倍，TTL30s。",
    "exit": "stop=C-2ATR、D≤3ATR、target3D；B两根价格失败、新合格日z≥+2或72根1h边界；归零至少24h冷却及新日窗/新穿越。",
    "risk": "r≤0.25%、名义≤15%，私人和组合可收紧。",
    "data": "BTC原生专业实体/标签/净流/旧版历史，目前缺口；RPC/WBTC/定点地址/ETF消息不可代替。",
    "validation": "原卡专业标签/点时审计，40setup/25成交/测试10候选量；标签后补、内部归集、日更延迟与MAD0。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "event",
    "execution": "spot"
  },
  {
    "id": "RX04",
    "name": "解锁/分发压力防御覆盖层",
    "market": "ARB允许SPOT基础策略，品种待核",
    "timeframe": "事件/1h",
    "setup": "逐批U/S≥1%，防御窗[T_min-72h,T_max+72h)；重叠合格窗只合并窗口/取最严上限，不合并U分母。进入WATCH停新买。",
    "entry": "这里入场是进入防御，不是新买/做空。T_min-24h后P=0.25*U*bid/1%深度≥3或可证受益者对外净分发24h/U≥10%才REDUCE；某分支未知不挡另一个有效分支。",
    "exit": "REDUCE冻结基础cap50%所对应q_ceiling；可归因DEX净卖出/U≥10%且1h close跌破前24low则HIGH_RISK目标0。普通到期仍需覆盖/无新D/X24h及2根close>EMA20才按预批解除；不自动买回。",
    "risk": "没有新建仓预算；只减少已批准基础策略库存。一个退出协调器，不超卖；未知报价/库存/订单等待对账，不能声称已减仓。",
    "data": "官方批次/流通量/受益者版本、链事件完整性/归属、现货深度/账户。CEX转入不是卖出，基础策略必须支持该资产。",
    "validation": "原卡条件实验n_base10%/初始10%/REDUCE5%、共同合法stop、截止Tmax+72h估值；24批次/测试8候选量，另分P/D/X覆盖与可部署基础组合。",
    "version": "research-v0.1",
    "abc": {
      "A": "WATCH保持保护，不新增买入",
      "B": "P或D有效则REDUCE，冻结目标不反复补卖",
      "C": "X加价格破位/硬风险取更严目标；分支未知与卖出核心未知分开"
    },
    "kind": "event",
    "execution": "research"
  },
  {
    "id": "RX05",
    "name": "单所杠杆清理后的现货确认",
    "market": "Binance BTCUSDT SPOT/PERP输入，SPOT执行",
    "timeframe": "OI15m，SPOT5m",
    "setup": "正已结算funding f8≥历史P90、base数量OI24h≥+10%、basis≥P75时ARM，冻结分位。24h内首次OI60m≤−5%且价格回撤≥1.5ATR，记录该OI点为stress并建立2h episode。",
    "entry": "真实可得t0后的前三根5m冻结range；新上破、EMA20、成交额1.5倍、spot delta≥0.10，最新OI≤stress*1.03且basis≤冻结P90；TTL5s一次IOC。",
    "exit": "stop=min(L0,C-1.5ATR)、D≤3ATR、target2D；B两根回range、合格delta≤−0.1且close≤EMA20或24根边界。再拥挤仅停新风险，不单独反手；终结后6h/false reset。",
    "risk": "r≤0.25%、名义≤10%；不做合约单，不用美元OI下降冒充数量清理。",
    "data": "同所OI单位/历史、当时funding interval、mark/spot错时≤2s、完整spot aggTrade；OI官方近月历史限制。",
    "validation": "原卡分组增量对照，60episode/30成交/测试15且跨波动环境候选门槛；stress94,000→上限96,820、时间分位冻结/迟到/费周期变化必核。",
    "version": "research-v0.1",
    "abc": {
      "A": "全部新风险门槛通过才入场；已有仓位按原计划管理",
      "B": "策略失败/时间/目标退出交唯一协调器，不等模型",
      "C": "暂停新增与确定强退出分开；未知订单/库存先对账"
    },
    "kind": "event",
    "execution": "spot"
  }
];
export const strategyById=id=>CATALOG.find(s=>s.id===id);

// Product navigation describes capability coverage, not ten additional executable strategies.
export const BOT_PRODUCT_CAPABILITIES=[
 {id:'spot-grid',name:['现货网格','Spot grid'],family:'S01',kind:'family',scope:['现货','Spot'],detail:['固定中心、四买层；区间和2–100格图表只作预览，追踪上移另建候选版本。','Frozen center and four buy levels. The 2–100 grid chart is a preview; trailing up requires a separate candidate.']},
 {id:'spot-dca',name:['现货 DCA','Spot DCA'],family:'S02',kind:'family',scope:['现货','Spot'],detail:['有限三层篮子，共同止损与整篮预算；并非按日定投。','A bounded three-layer basket with a shared stop and budget, not daily recurring purchases.']},
 {id:'rebalance',name:['智能持仓','Portfolio rebalancing'],kind:'candidate',scope:['多资产现货','Multi-asset spot'],detail:['含现金权重合计100%；核对偏离百分点、成本阈值、各腿完成量和剩余偏差。','Weights including cash total 100%. Check percentage-point drift, costs, completed legs and remaining imbalance.']},
 {id:'spot-twap',name:['现货 TWAP','Spot TWAP'],kind:'execution',scope:['现货执行方式','Spot execution method'],detail:['在已批准父单内分时执行；已成交、未确认和剩余量分开，取消前保留占用。','Schedule slices of an approved parent order. Separate fills, unconfirmed quantity and remainder; retain reservations until cancellation is confirmed.']},
 {id:'perp-twap',name:['合约 TWAP','Futures TWAP'],kind:'execution',scope:['合约执行方式','Futures execution method'],detail:['父单另需方向、减仓、保证金及资金费；现货能力不能继承为合约可用。','The parent order also needs direction, reduce-only, margin and funding. Spot capability does not enable futures.']},
 {id:'perp-vp',name:['合约 VP','Futures VP'],kind:'execution',scope:['合约执行方式','Futures execution method'],detail:['按真实成交量参与率执行，处理断流与剩余量；固定时间切片不等于VP。','Follow actual volume participation, handling feed loss and remaining quantity. Fixed time slices are not VP.']},
 {id:'funding-hedge',name:['套利机器人 · 资金费对冲','Arbitrage bot · funding hedge'],kind:'candidate',scope:['现货 + 永续','Spot + perpetual'],detail:['分别核对两腿、净成本、结算时间和未对冲敞口；不等同于S09-A同链原子套利。','Check each leg, net costs, settlement times and unhedged exposure. This differs from S09-A atomic on-chain arbitrage.']},
 {id:'perp-grid',name:['合约网格','Futures grid'],kind:'candidate',scope:['合约','Futures'],detail:['独立核对多空方向、仓位模式、合约乘数、保证金和清算；不是现货网格加杠杆。','Independently check direction, position mode, contract multiplier, margin and liquidation. Leverage alone does not turn a spot grid into a futures grid.']},
 {id:'perp-dca',name:['合约 DCA','Futures DCA'],kind:'candidate',scope:['合约','Futures'],detail:['限制层数、名义额与整篮亏损；止盈后先处理迟到补单，不无限追加保证金。','Bound layers, notional and basket loss. Reconcile late additions after take-profit; never add unlimited margin.']},
 {id:'pyramiding',name:['滚仓宝 · 盈利加仓','Profit pyramiding'],kind:'candidate',scope:['独立加仓方案','Separate scaling plan'],detail:['核对触发、次数、增量、已生效保护和总风险；浮盈不扩大风险上限，不做亏损摊平。','Check triggers, count, increments, effective protection and total risk. Unrealized gains do not raise risk limits; no averaging down.']}
];
