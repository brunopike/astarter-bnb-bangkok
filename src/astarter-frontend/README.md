> **当前发布入口（2026-11-12）**：4188 应用的 GitHub / Vercel 发布说明见 [DEPLOYMENT.md](./DEPLOYMENT.md)。下面按时间保留原有开发记录，不能作为云端服务已接通的证明。

This public Hackathon edition opens Onchain Deep Brain and its interactive evidence graph. The [hosted demo](https://dapp.ipfund.art/) also includes a licensed particle portrait. The public source includes the graph, research notes, and asset picker. To run it, use Node.js 24, then run `npm ci` and `npm start`.


# HIVE · 当前前端 v0.34（2026-10-29 API 动态图标与场景清理）

[AI 协作台](http://127.0.0.1:4188/?page=workbench) · [AI 信号](http://127.0.0.1:4188/?page=signals) · [社媒动态](http://127.0.0.1:4188/?page=social) · [市场行情](http://127.0.0.1:4188/?page=markets) · [交易助手](http://127.0.0.1:4188/?page=assistant)

2026-10-29 图标维护：图标层消费资产API的image_url，按asset_id+symbol或chain+contract绑定，不受本地30币缓存限制；元数据缓存24小时，匿名CORS/no-referrer，只允许两个CoinGecko图片CDN。用ONDO、WLD、POL、TIA、PENDLE、AR六个缓存外币种的真实公共图标元数据验证解析/渲染，未保留或引入行情价格。现有11场所、6类非币资产也有图标，API配置和交易对共用组件。去掉场景设备名/角色号/协作小字；couriers.js只删除一行可见标签，动作和轨迹保留。244项测试与语法检查通过。真实数据后端仍按独立门禁联调，AI现场继续模拟。

[图标与场景验证](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/evidence/2026-10-29-icons-labels/verification.json>)

2026-10-29：按三会话冻结合同新增公开只读 DataClient、四路 GET 同源代理、行情/资料/新闻和逐链能力登记视图。[只读行情](http://127.0.0.1:4188/?page=markets&data=live) · [只读快讯](http://127.0.0.1:4188/?page=intelligence&data=live)。页内可切换只读/演示，原默认演示保持；未接页面明确标演示。真实数据、离线合同样本及本地模拟账户分别标记，不互相补数据，不驱动模型、积分或交易。

前端使用 `AstarterPublicData.v1` / `PUBLIC` / `public-data-projection.v1`，校验选择版本与场所/资产/计价单位；错误、缺失、过期分别保留。四路代理仅去 `127.0.0.1:8765/v1/data/...`，只接公共 GET，不转发用户 Cookie/Authorization/Forwarded；CSP 只允许同源连接。凭据和供应商传输由后端/数据会话管理，浏览器无供应商 Key。多链能力页展示带日期的逐项测试记录，不是实时查询或整链授权证明。

本轮全套 231 项测试通过（新增 16 项），中央 11 文件哈希一致。浏览器已检查 1366/390/320、深浅、双语窄屏、断线不回退、说明浮层和跨页模式保持。成功数据行/资料/快讯的浏览器联调仍需后端 8765 就绪；当前只读服务未连接时返回明确 503，没有启用真实交易。[本轮状态与证据](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/evidence/2026-10-29-readonly-data/verification.json>)。

2026-10-28 产品 UI/UX 复查：原 4188 无监听的问题已恢复，现用 `hive-product` 托管。收紧共用页头、账户栏、策略入口和手机布局；聪明钱页连接现有账户、持仓与历史动态；修复新交易进度误读上一实例的计划。窄行情图默认显示最近 40 根 K 线，可显示全部；宽图保留完整范围。215 项测试与语法检查通过，中央场景 11 个文件保留哈希一致。仍为本地模拟。

[本轮产品与流程复查](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/整站可读性与流程审查_2026-10-28.md>) · [验证记录](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/evidence/2026-10-28-product-review/verification.json>)

追加信号与社交交易维护：AI 追踪现有 12 项资产、47 条固定日期的连续更新，支持来源、状态、搜索、追踪和分页，保留原协作评估及模拟下单流程。社媒现有 8 个虚构账户、36 条观点/调仓/账户动态，支持资产筛选、关注、收藏、原观点、账户持仓及历史记录。浏览与追踪不扣积分；进一步研究仍先确认积分。跟单尚未开放，账户页不再把未开放入口显示成可配置功能。

去掉工作页重复介绍和策略库宣传式大段标题，账户页以名称与数据为主；手机详情与窄图刻度已调整。最新 `npm run check` 与 211 项测试通过，浏览器检查 1366px、390px、320px、深浅主题和英文窄屏；中央协作动画及交易/积分引擎文件未变。

本轮统一全站字号与深色可读性，维护手机表单和数据布局；修复自动刷新丢失预算与焦点、订单返回筛选、积分账单定位检查，以及检查未通过后返回策略设置的衔接。补充校准 14 寸笔记本的阅读密度：常读正文约 15px、控件 14px、说明 13px；手机正文与表单 16px。中央小人、流线、动作与模拟交易/积分计算文件保持不变。沿用现有 4188 服务，全部仍为 simulation-only。

手机数据页参考 Coinglass 与 Binance 实际移动端：行情默认简洁列表，可切完整数据；排序、搜索、自选沿用同一数据集。概览与排行榜收进展开区，横滑表格固定资产/日期列。图表支持点选读数、缩放、横拖区间，纵滑继续翻页；行情解读采用同一周期与窗口。信号页统计收紧，宠物不再遮挡列表。

前轮检查了 24 个页面的深浅主题与 390px 手机默认布局；补充检查 320 / 390px 数据页、双语窄屏和 1280 / 1366 / 1512px 笔记本布局。此前实测引导、机会、模拟买卖、日志、资产、积分、检查未通过及数据到助手流程，204 项测试通过；本次信号与社媒追加验证见上文。未接真实数据、模型、支付、钱包或交易。

[本轮完整审查与证据](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/整站可读性与流程审查_2026-10-28.md>)

以下保留各阶段记录，当前入口以本节为准。

---

# HIVE · v0.27 基线记录（2026-10-26）

[AI 协作台](http://127.0.0.1:4188/?page=workbench) · [执行链路](http://127.0.0.1:4188/?page=execution) · [五步引导](http://127.0.0.1:4188/?page=setup)

沿用 Cursor 四域导航与完整18 Agent场景。新增执行来源链、准入阻断、持仓保护覆盖、同源成交费用账本、原操作查询、账户作用域与读取恢复、能力目录和五步预检流程。仍为 simulation-only；未接真实交易与后台。

`npm run check` 与124项测试通过。预览标识 `hive-motion-0.27 / simulation-only`。

[实施范围、验收与限制](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.27/前端实施与验收_2026-10-26.md>) · [18项页面及后端差异映射](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.27/页面合同差异映射.md>)

以下为历史阶段记录，以本节和v0.27验收为当前入口。

---

# HIVE · v0.26 基线记录（2026-10-26）

[打开 AI 协作台](http://127.0.0.1:4188/?page=workbench) · [当前基线与验收](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.26/前端当前基线_2026-10-26.md>)

采用 Cursor 更新后的四个业务域：现场负责 18 Agent 研究及市场、链上、宏观信息；裁定只呈现需要用户接手的候选、逐笔确认和未知回执；授权管理策略版本、演练、范围与限额；账本查看模拟委托、资产和积分。保留中央动效、深浅主题、手机布局和中 / EN 切换。全部仍为本地模拟，未接真实交易或外部账户。

本轮核对新增裁定/授权页的英文手机界面与接管状态，修正可见文案、浏览器标题和旧页脚版本标识。`npm run check` 与 110 项测试通过；预览响应标识 `hive-motion-0.26 / simulation-only`。以下为旧阶段记录，当前功能以本节及代码为准。

---

# HIVE · 协作动效与双语界面 v0.26

[打开 AI 协作台](http://127.0.0.1:4188/?page=workbench) · [本轮实现与验证](</Users/mac/Documents/AI Space/Projects/交易大法/docs/product/HIVE_协作动效与双语界面_v0.26.md>)

六种工作场景、跨组专家协查、直送与会审双路径；核验/模拟执行/复盘/积分与动作同凭据联动。核心用简短气泡汇报资料与结论，电脑操作员背身敲键盘，资料完整交到手边。区域重复小字隐藏；增加中 / EN 切换，保留深浅主题和手机布局。

41 脚本语法检查、103 项测试通过；可见桌面/手机与模拟业务链路已检查。仍为 simulation-only，未接真实数据、模型、支付或交易。视觉待用户确认；下方旧说明仅作过程和业务基线保留。

---

# HIVE · 可交互产品前端 v0.25

[打开 AI 协作台](http://127.0.0.1:4188/?page=workbench) · [实现与验证边界](</Users/mac/Documents/AI Space/Projects/交易大法/docs/product/HIVE_前端交互实现_v0.25.md>)

机会 → 策略版本 → 演练 → 私有复核 → 模式授权 → 模拟订单/持仓 → 积分流水已经串联。五个业务域、15 个路由，18 条策略研究目录，五步引导；保留原小人动效、深浅主题与手机适配。

37 个脚本语法检查、89 项 Node 测试；可见浏览器检查逐笔/自动/未知回执/积分预算/刷新恢复。仅本地模拟，真实数据、模型、回测、支付和交易均未接入；专用策略执行仍需后续适配。运行标识 hive-motion-0.25 / simulation-only。

视觉待用户确认；以下为历史版本说明，不代表当前恢复/存储行为。

---

# HIVE · 机会驱动协作台 v0.24

[打开协作台](http://127.0.0.1:4188/?page=workbench)

六个工作区分别负责市场结构、链上生态、情绪异动、全球权益、避险轮动和宏观事件。每组三人沿用同色身份、桌面符号与固定位置；代表采集、组内传阅和讨论、派人递交核心、核心反馈与回组协作，均由当前研究任务驱动。手机保留六区，隐藏重复组名栏。

默认展示研究方向，不再常驻列出资产和交易对。组内产生发现后，具体资产卡才出现；核心接收时高亮、结论形成时响应，交接后显示模拟执行状态。全部记录仍可按需查看。内部仍是八资产的确定性样例，并非接入全市场扫描。

右侧选择执行方式和限额后，可开启“机会接管”，接收下一条合格候选：自主模拟产生模拟委托，逐笔确认保留人工确认，只看信号不下单。接管锁定配置、按研究版本去重；一次接管建立一个会话，最多三个示例信号后暂停，停止后不自行重启。已有持仓、连接缺失、额度不符和证据分歧仍阻止新会话。TradFi 目前仅研究。

34 个脚本语法检查、75 项测试通过；可见浏览器检查 1440×900 / 360×740、双主题、机会出现、自然资料交接、手机详情转操作台、自主模拟成交及停止状态。所有数据、AI 与交易都是本地模拟；没有真实接入或部署。

[验证与截图](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.24/验证.md>) · [唯一工程](</Users/mac/Documents/AI Space/Developer/交易大法/工程/hive-motion-lab/README.md>)

视觉待用户确认。预览标识 `hive-motion-0.24 / simulation-only`；旧说明与截图保留为过程记录，未正式归档。

---
以下为历史版本；v0.23 的常驻资产列表和仅手动交接已由上述流程替代。

# HIVE · 多资产 AI 协作台 v0.23

[打开协作台](http://127.0.0.1:4188/?page=workbench)

18 个 Agent 分为六个互斥研究组，独立推进 BTC、ETH、SOL、SPX、NDX、XAU、DXY、US10Y 八项任务。每项任务有版本、六维证据、组内核验、核心汇总和结论；NDX/US10Y 等待本组前项完成，不是八条图表共享一个 BTC 结论。

宏观、舆情和链上样例共享给对应资产。注入新证据会让相关任务进入新版本，分歧和缺项会改变结论；不相关任务继续。核心逐组收报告，小人以当前资产标记，保留资料、讨论桌、反馈和小气泡；执行复核占用角色时，对应研究暂停推进。

下方资产卡 → 六维证据详情 → 明确交给操作台 → 核对参数 → 启动模拟。交接绑定资产与研究版本，不自动下单；重审立即使旧版本失效。当前仅加密候选可交接，TradFi 支持研究、详情与市场页送入任务，执行未适配。五步设置完成后先开研究，由用户交接候选再启动模拟。

仍为**本地预设交互样例**，没有真实市场数据、AI 决策、Nautilus 引擎或交易连接。研究与交易会话刷新即重置；暂停研究不等于暂停右侧模拟执行。

34 个脚本语法检查、71 项测试通过。可见浏览器检查了独立进度、ETH 候选交接、旧版本阻断（0 委托）、共享链上定向重审、SPX 从市场页进入研究而交易盘口保持不变、暂停冻结，以及 1440×900 / 1367×768 / 360×740 和双主题。实体手机、真实接口与远端部署未验证，视觉待用户确认。

- [验证记录](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.23/验证.md>)
- [唯一工程](</Users/mac/Documents/AI Space/Developer/交易大法/工程/hive-motion-lab/README.md>)

预览标识 `hive-motion-0.23 / simulation-only`。旧截图与历史版本说明保留为过程证据，未做正式归档。

---

以下为历史版本说明，单盘口聚焦核验已由 v0.23 独立任务替代。

# HIVE · AI 协作台 v0.22

多市场补充：页面统一命名「AI 协作台」。默认观察 BTC、ETH、SOL、SPX、NDX、XAU、DXY、US10Y 的同窗相对数值走势，可独立切换单资产图表；右侧模拟执行和聚焦核验仍保留明确盘口。六组后台观察任务带有资产范围。新增按行为触发的表情气泡（桌面最多3个、手机2个），色条外缘扩大约12%。32脚本检查、62测试通过。

布局补充：底部配置栏改为独立布局行；桌面中央内容改用网格流式排版，标题与行情并排，动效自适应剩余高度，行情图和研究结论完整显示。窄桌面卡片上下排列；小手机保留内容区滚动。32 脚本检查、59 测试通过。

交接闭环补充：核心反馈后，递交者点头确认、接回同一份资料，携带任务返回对应小组，交给同伴并继续讨论；宽屏会议与讨论桌向两侧展开，手机保持紧凑。不新增文字卡。32 脚本检查、59 项测试通过。

[打开工作台](http://127.0.0.1:4188/?page=workbench) · [代码采用记录](REFERENCE-ADOPTION.md)

六组角色错峰协作、两处讨论桌、资料交接与少量状态气泡；核心补充关注、阅资料、思考、点头四类反应。手机保留行情采集区。数据页实际复用 MMDock 计算模块和 ValueScan 本地资金/舆情表达，保持现有配色和模拟账本。

32 个脚本检查、53 项测试通过；桌面、手机、双主题、窗口/筛选、证据详情、模拟对账和暂停已验证。当前预览 `hive-motion-0.22 / simulation-only`，未部署、未接真实交易。详见 [v0.22 验证](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.22/调整与验收.md>)。

以下保留历史版本记录：

---

# HIVE · 产品页面与配置中心 v0.21
本轮动效补充：大小角色均参与六组错峰协作，9.6 秒一轮，轮换携带与递交资料，覆盖全部 18 个角色。新证据与执行任务优先，日常复核不增加证据或交易。30 个脚本检查、47 项测试通过；桌面两次观察全部 18 个角色均有明显位移，手机 360px 检查无整页溢出，暂停保持位置不变。


[工作台](http://127.0.0.1:4188/?page=workbench) · [市场数据](http://127.0.0.1:4188/?page=markets) · [初始设定](http://127.0.0.1:4188/?page=setup)

页底改为五类配置状态与明确的管理入口；连接中心提供分类导航、草稿、检查、保存反馈和下一步引导。市场图表支持读数、缩放、平移和周期切换；追踪、消息、策略、日志、资产与五步设定统一了页面层级、排版和实际操作。保留 v0.20 机器人协作与原执行状态机。

参考当前 MMDock 数据中心、设置页和图表交互；通过 stark-321ui 取得 21st Integrations 02 作为布局参考，适配到原生 DOM，无新增依赖。

**仍为本地模拟，未接真实数据、模型、交易所或钱包。** 日志和资产共用模拟账本，权益按固定成交价估值。30 个脚本检查、46 个测试通过；可见浏览器检查桌面/手机、深浅主题、配置保存/错误、图表交互、五步启动和模拟对账。实体手机、跨浏览器和远端环境未验证，视觉待确认。

- [本轮验证与截图](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.21/调整与验收.md>)
- [页面与交互规划](</Users/mac/Documents/AI Space/Projects/交易大法/docs/product/HIVE_页面与交互规划_v0.1.md>)

预览标识：`hive-motion-0.21 / simulation-only`。沿用唯一工程和托管预览，未发布、未正式归档。

---
以下为历史记录，以顶部 v0.21 为当前工作稿。

# HIVE · 机器人协作动作 v0.20

[打开工作台](http://127.0.0.1:4188/?page=workbench)

研究结束后，三组 Agent 以 12 秒周期错峰复核已有样例，每组 2–3 人。动作依次为访问来源、会合、面向同伴交流、轮流交接资料、由一人送入核心、回位；宏观/趋势、舆情/量价、链上/盘口与风控条件分别对应角色小组。新证据携回优先，模拟信号和订单仍关联原有身份，单人不展示成会议。

移除悬浮的五根短线，改为同一份折角纸页：在手上拿稳、传给同伴、再缩小收入核心。配合转头、点头、交替手势和更明显的步伐；不添加文字卡。移动端调整会议间距，切换视口时重置旧坐标。

**仍为本地模拟，未接真实数据或 AI。** 日常协作仅复核已有示例，不生成新证据、结论或交易。右侧操作台和八个产品页面逻辑沿用 v0.19。

本轮验证：27 个脚本语法检查、41 个状态测试通过；浏览器观察桌面/手机、浅色/深色、资料交接与提交、研究结束后的持续活动、暂停冻结，未见浏览器错误。未作远端发布，视觉效果待用户确认。

- [本轮验证记录](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.20/调整与验收.md>)
- [页面与交互规划](</Users/mac/Documents/AI Space/Projects/交易大法/docs/product/HIVE_页面与交互规划_v0.1.md>)

预览标识：`hive-motion-0.20 / simulation-only`。运行 `npm start`；验证 `npm run check` 与 `npm test`。

---
以下保留历史记录。

# HIVE · 多页面交互产品样片 v0.19

[工作台](http://127.0.0.1:4188/?page=workbench) · [首次配置](http://127.0.0.1:4188/?page=setup)

保留彩色机器人工作台，扩展市场数据（含 TradFi）、AI/链上追踪、舆情宏观、策略广场、交易日志、资产报表与五步初始设定。旧网状球、积木、场域不再提供运行入口。页面导航不重建模拟会话；刷新会重置执行状态。

宏观、社交舆情与链上样例加入同一证据时钟，角色按来源采集并交接。情报页面可送往研究；高影响宏观标记分歧，未核实舆情保留缺口，链上转账仅作旁证。结论与模拟启动门槛使用同一筛选结果。

复用原有 ASTARTER 双主题、机器人及操作台；借鉴 MMDock 资产/日志口径，复用 valuescan-local SVG K 线组件。无新增依赖。S00–S09 十个策略身份可复制模板草稿，只有 S03 提供预设交互模拟。

**边界：本地前端模拟，无真实行情、模型、账户、钱包、API、Nautilus 或外部通知。** TradFi 仅观察；资金数据和新闻是固定合成样例。订单/资产共用 TradingDemo，固定启动价估值；自主最多三个预设信号后暂停。日志保留最近 30 单和 40 条事件，不代表持久后端账本。

验证：27 个脚本语法检查、39 个状态测试通过；浏览器检查五步配置、限额校验、研究到自主模拟、日志/资产对账、宏观分歧、追踪持久化、搜索空态、手机各路由无根级横向溢出、双主题和连接入口。当前预览为 `hive-motion-0.19 / simulation-only`，无远端发布，待视觉确认。

- [页面与交互规划](</Users/mac/Documents/AI Space/Projects/交易大法/docs/product/HIVE_页面与交互规划_v0.1.md>)
- [验证记录](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.19/调整与验收.md>)

运行：`npm start`；验证：`npm run check && npm test`。已托管预览：`.goodway/preview/hive-motion.json`，管理脚本为 `/Users/mac/.codex/skills/stark-vibe-coding-goodway/scripts/preview_session.py`，状态/停止均使用 `--name hive-motion --cwd <本工程绝对路径>`。

---
以下为历史实现记录，能力与界面以以上 v0.19 为准。

## v0.18 历史记录

**[打开当前样片](http://127.0.0.1:4188/?scene=reactor)**

18 个可点选的彩色角色按任务工作。研究阶段组织趋势/结构、量价正反条件、规则/等待/失效、分歧/保护小组；小人去来源处核对，再会合、手势讨论、交换短流束并回位。信号、委托与成交回报驱动风控/执行/诊断/复盘角色，关联任务或订单编号。完成研究后进行有限的来源状态巡检，无新增数据时不增加证据和结论。

右侧分为交易、研究、回报。交易页选择 BTC / ETH / SOL 现货示例盘口、S03 模板、逐笔确认/自主模拟/只看信号、单笔金额和敞口上限。所选盘口需先核验；连接关闭、研究未就绪或有分歧会阻断启动。启动配置冻结，编辑用于下一次启动。自主示例每轮最多 3 个信号后暂停；信号先有复核窗口，再进入提交、部分成交和成交。暂停撤销未成交部分并保留持仓；停止不会自动清仓，退出持仓需单独操作。

底部提供交易所、数据 API、AI、钱包、通知入口；手机使用“连接”导航打开抽屉。模拟配置保存到本浏览器并读回，下一次运行生效。AI 提供方和预算是配置演示，不产生调用/费用。真实凭据输入不开放。站内提示可点开回报；关闭页面不继续运行或推送。

**交付边界：前端交互样片，所有研究、信号、成交和资金均为合成示例。** 仅 S03 有预设交互路径，不执行真实均线/RSI 指标计算；不接交易所、AI、钱包、Nautilus 或外部通知。订单使用启动时同一合成价格快照和示例 0.10% 手续费。前端算术仅用于验证交互，不替代既定交易引擎或真实账户账本。刷新重置本页交易会话，连接偏好及原研究记录保留。

24 个脚本语法检查、34 个状态测试通过。可见浏览器检查桌面/手机、双主题、连接阻断/保存读回、盘口研究联动、逐笔确认、自动三信号、停止持仓保留与单独退出、运行配置冻结、18 角色和协作任务绑定。详见 [本轮验证](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.18/调整与验收.md>)。待用户视觉确认，无远端发布。

以下为历史试验记录，不描述当前默认视图。

## 既有第三方案试验记录（非主方案）

v0.10已被用户明确否定。当前v0.11是重做后的本地候选，尚未获用户视觉确认。根路径现已切回网状球；构建`hive-motion-0.11`，模式`simulation-only`。

第三方案重做中央体量：576条连续候选纤维构成流动背景，选中证据从同一批源纤维中牵出、卷束、收紧，交织成有纵深的开放折叠形体。删除原先稀疏短片、左右流程分区、Agent排队站点和阶段浮标。紫色纤维中的流动与局部形变持续存在；没有HUD、链条、光环或附加科幻装饰。

三种预设有5/7/4个参与角色，4/6/3个证据组。每组24个视觉证据单位，每单位3根微纤维，首次约12秒成形。新事件在相关区域引入6/24组新纤维，先牵引和收束，再局部松开、补织，其余证据身份保留。时长7.2秒。以上均为视觉构件数，不是市场信号、收益或模型置信度。

保留Astarter深浅主题、本地 Inter / Noto Sans SC·JP·KR / IBM Plex Mono、左右工作区与操作台、手机分页。手机保留完整织体并调整为竖向构图。所有角色、证据和结论均为预设模拟，没有行情、模型、钱包或交易接口，没有远端发布。

## 操作

- 「重播」从灰色候选流动开始；约6秒看牵引卷束，约12秒形成完整织体。
- 注入行情、波动、风险事件，观察相关区域局部松开和补织；暂停、单步+3秒、倍速保持同步。
- 方案选择后「应用并重启」；角色聚焦、旋转、缩放、标签/路径开关继续可用。聚焦线索会降低背景候选的显著性。
- 三个场景共享配置、模拟时间和暂停；切换后视觉队列和中间姿态重建。原有网状球与积木代码未改。
- `motion=reduced`默认暂停并显示完整织体；`renderer=static`显示明确标识的SVG，三维控制禁用。

## 来源与检查

按stark-321ui重新查阅ThreeUI Ribbon Field和Flux Vortex。前者为点阵色带，后者为粒子漩涡与辉光，均未直接套用；Ribbon Field Pro CLI实际返回404 component_not_found，不能宣称获取成功。本轮采用现有Three.js定制连续带状几何与GPU形变，没有新增依赖或下载外部源代码。v0.9来源及MIT声明保留用于追溯，旧地形shader不在当前运行路径。

11文件语法检查、7项状态测试通过；已实看牵引、成形、局部替换、双主题、三预设96/144/72个视觉证据单位，暂停截图一致、手机构图、低动态及静态回退。技术通过不代表用户接受视觉方向。

直开样片渲染日志无警告/错误。手机360为实际同源iframe尺寸检查，395为直开浏览器视口，均未验证物理设备。iframe辅助页前轮存在来源未定位的MutationObserver日志，本轮不宣称修复；未做跨浏览器性能、长期内存或下载/复制重验。

- [本轮调整与证据](</Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/v0.11/调整与验收.md>)
- [项目入口](</Users/mac/Documents/AI Space/Projects/交易大法/outputs/hive-motion-lab/README.md>)

## 运行、停止与日志

当前验收环境 Node.js 24.14.0；商业模拟账本使用 Node 内置 SQLite。图形依赖沿用工程现有 Three.js / ECharts，无新增运行依赖。`npm ci --ignore-scripts`安装，`npm run check` / `npm test`验证，`npm start`运行。

预览`http://127.0.0.1:4188/`，当前预览名`hive-product`，当前日志路径见 `.goodway/preview/hive-product.json` 的 `log` 字段。

```sh
python3 /Users/mac/.codex/skills/stark-vibe-coding-goodway/scripts/preview_session.py status --name hive-product --cwd '/Users/mac/Documents/AI Space/Developer/交易大法/工程/hive-motion-lab'
python3 /Users/mac/.codex/skills/stark-vibe-coding-goodway/scripts/preview_session.py stop --name hive-product --cwd '/Users/mac/Documents/AI Space/Developer/交易大法/工程/hive-motion-lab'
python3 /Users/mac/.codex/skills/stark-vibe-coding-goodway/scripts/preview_session.py start --name hive-product --cwd '/Users/mac/Documents/AI Space/Developer/交易大法/工程/hive-motion-lab' --port 4188 --max-port 4188 --expect-header X-App-Build=hive-motion-0.35-integrated --expect-header X-App-Mode=simulation-only -- node server.mjs
```

旧证据保留，无正式定稿或归档。本地预览由管理器维持，未安装后台监控或开机启动。


## v0.32 · Data Center reference rebuild (2026-10-26)

Run `npm start`, then open `http://127.0.0.1:4188/?page=markets`.
Data Center now has market overview / rankings / weighted heatmap / exchanges / asset detail; funding, open interest, liquidation and long-short views; a grouped on-chain catalogue with indicator detail; macro timeline and calendar; social feed, trader discovery, ranking and profiles; separate BTC/ETH ETF tables and fund detail.

`data-center-fixtures.mjs` owns deterministic data and selector calculations. `data-center.mjs` owns routes and interactions; `data-center.css` is scoped to the shared product shell. All sources remain simulation-only. A watchlist or alert preference is a local browser setting, never a live subscription or order. Credit-confirmed research continues to use WorkspaceSim.

Evidence: `../../任务/01a163d9_蜂巢动效样片/evidence/v0.32-data-center/implementation.md` and `verification.json`. The central collaboration scene is unchanged. Local checks: 147 tests pass. This is the primary data-page structure and representative data set, not a full mirror of every CoinGlass metric or paid feature.


### 2026-10-27 · 交易助手与交互修正

入口：`http://127.0.0.1:4188/?page=assistant`。导航统一增加「AI 助手」。21st Chat02 / Conversation List 的原始来源和本地适配记录见 `REFERENCE-ADOPTION.md`。沿用 Astarter 深浅配色。

- 交易问答使用本地示例规则；资料分析保留原文和引用，不验证新闻真伪；行情解读以所选模拟 K 线实际计算区间涨跌、高低点、MA5/20、Wilder RSI14。不是实时 AI 或收益判断。
- 1H 为市场样例的 168 根小时线，4H 从同一组小时 OHLC 聚合；分析与图表使用同一窗口，历史结论可返回对应窗口。少于 8 根不分析；不足 15 根不会制造 RSI。
- 数据中心的行情、指标和新闻可通过「带资料问 AI」带入当前对话；也支持选中页面文字后摘取。资料页的小白人提供「问 AI」入口。
- TXT/MD/CSV/JSON 作为原文读取，每个文件最多 64 KB / 6,000 字；一条消息最多 6 份资料。不访问资料中的 URL，不执行其中的指令。
- 当前聊天、文字整理和本地 K 线计算不使用积分，不触发研究、订单或交易。深度研究仍通过原有确认与积分流程。
- 本机最多保留 12 个对话，每段最多 24 轮；达到上限会提示，正常使用不会静默删除旧对话。可置顶、切换、刷新恢复、导出 JSON。存储失败会显示提示。
- 市场总览将 RSI 均值换成恐慌与贪婪样例 51，移除重复项，补充口径说明；默认卡片中性，悬浮/聚焦再强调。恐慌指数范围定义参考 https://alternative.me/crypto/fear-and-greed-index/ ，没有接入其实时 API。
- 策略示意图进入页面时静止，仅鼠标移入后响应，移出停止；隐藏页面与减少动态效果设置会停止时钟。
- 搜索框统一 SVG 尺寸和边距。确认弹窗关闭按钮使用 SVG，实测叉号与按钮中心一致；主按钮在两种主题的悬浮态保持可读。

本轮证据：`/Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/evidence/2026-10-27-assistant-ui`。工程快照/测试日志：`.goodway/assistant-ui-20261027`。本地服务仍为 simulation-only，不属于部署。


### 2026-10-27 · 中央现场配色（鲜明版）

当前六组颜色统一从 `RESEARCH_GROUPS` 读取：鸢尾紫 #8a6fff、翡翠绿 #00b68c、玫瑰粉 #de6cbc、晴蓝 #5a98f3、琥珀黄 #ecb427、珊瑚杏 #f5866a。替换了此前偏灰的低饱和方案。小人、资料、设备、流线、数据源与左侧小组标记仍共用同一色系；UI 淡紫主色保持不变。

缩小头部高光的扩散区域，恢复饱和中间色和较深的边缘、腿部，保留立体感。流线减少淡紫/白色混合，浅色保留主线与尾迹层次，深色单独提高底层透明度。几何、速度、路径、动作、交接节奏和业务逻辑没有改动。

配色使用现有 ColorAide 工具在 OKLCH 中生成并输出 hex，没有新增运行时依赖。备份和色值记录在 `.goodway/scene-palette-vivid-20261027`；当前实页证据在 `/Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/evidence/2026-10-27-scene-palette-vivid`。深浅两种主题分别检查桌面与 390 px 手机显示；语法检查通过，28 项相关测试通过，10 个动作/业务文件哈希不变。

### 2026-10-27 · 连续信息束与统一现场背景

`reactor.js` 已取消按固定线号长期加重的主线。相邻线条使用相近的明暗相位组成信息束，亮部沿现有流速前移，尾迹连续衰减，粗细跟随同一明暗包络过渡。原有中心线几何、方向、速度、采集/交接和 Agent 动作没有改变，六组小人配色保持鲜明版。

`bento-system.css` 中现场底色改用 `--b-bg`，与中间区域外框完全一致；气泡、设备和资料底色复用产品面板色，去掉旧暖棕场景底。深色为 #18161d，浅色为 #f6f3ee；没有增添背景装饰或新 UI。

语法检查及 23 项现有动作/研究测试通过。深浅主题分别检查桌面与 390 px 手机渲染，WebGL 未观察到控制台错误；15 个配色/角色/业务文件哈希不变，中心线函数及 shader 之外的 JS 完全不变。连续截图覆盖 1.45 秒，GIF 使用实际截图和采集时间，没有补间帧；其循环端点属于截取边界，不代表页面动画会重置。

备份和 diff：`.goodway/stream-bundles-surface-20261027`；当前实页证据：`/Users/mac/Documents/AI Space/Developer/交易大法/任务/01a163d9_蜂巢动效样片/evidence/2026-10-27-stream-bundles-surface`。


## 2026-11-06 · P0.6.1 会员、充值与 Credit

[会员入口](http://127.0.0.1:4188/?page=plans)统一会员、充值、用量及账单；所有收费均为模拟。报价、权限、原子预留、实际模拟成本结算、释放、退款及 Team 预算由 `/api/commerce` 和 `.goodway/commerce/preview.sqlite` 处理。数据库不提供静态下载；不要把它复制到交付包或覆盖其他人的模拟订单。

`membership-account.mjs` 是页面客户端，`commerce-ui.mjs` 共用费用确认，`commerce-catalog.mjs` 是 P0.6.1 目录。旧 `membership-state.mjs` 及其测试保留为 P0.3 历史样例，当前资金流程不使用其本地余额。此前文档中“所有聊天免费/本地扣分”的描述属于历史版本；当前按新报价规则模拟计费，基础 FAQ、旧结果和安全动作仍免费。

本地完整回归 639/639，独立并发与退款检查通过，并实测手机/桌面代表流程。详细入口、五前端映射和生产边界见 [实施与验收记录](</Users/mac/Documents/AI Space/Projects/交易大法/docs/development/Astarter_会员Credit统一接入_本地验收_2026-11-06.md>)。真实支付、真实身份、付费供应商和实盘托管仍未接通；此版不是可售生产服务。

### 同日后续：商业页面与共享弹窗

会员页明确本期与下期生效；充值确认才创建订单，失败重试使用同一订单；退款显示取消的 Credit 和会员影响。用量拆分余额来源/预留/实扣/释放，账单提供状态筛选。表单草稿和展开状态在账户同步后保留，明暗和窄屏控件已复核。当前语法检查及 653/653 回归通过（含 9 项商业界面测试），最新证据见上述验收记录的“后续页面优化”一节。真实收费仍关闭。


### 同日后续：Usage / Billing 参考与全站样式

用量新增按 UTC+8 完成日期的 7 / 30 天、本月统计、服务分项和 CSV；服务端聚合覆盖整个范围，任务表仍明确显示最近 200 条。账单改为会员 / 余额概览和可筛选订单表，保留恢复与退款流程，订单可导出 CSV。卡片与现有策略 / 数据中心复用 optical 表面变量、12 px 圆角和 1,440 px 内容容器。导航统一 Usage / 用量。

当前检查点：语法通过，657/657 回归，42/42 商业专项；可见下载、主题及响应式代表页检查完成。当前证据见实施与验收记录的“Usage / Billing 参考优化与全站样式对齐”。真实收费、付费供应商和生产发布保持关闭。


### 2026-11-07 · AI 积分入口与账户页修正

按最新用户指示，AI 积分独立只含会员、充值、用量、账单。连接设置归设置，资金保护在交易中心第二项。当前入口不显示工作区 / Team 管理，统一默认个人账本，提供 Free / Starter / Pro；旧 Team 账本与档案保留隔离。页面排版和窄屏重新调整，668/668 回归及 39/39 专项通过，并实际检查代表画面。前次 UI 记录不代表用户认可，当前证据以实施记录 2026-11-07 检查点为准。真实收费关闭。


### 2026-11-07 · 四页共用布局与 Vercel Usage 参考

会员 / 充值 / 用量 / 账单改用全站 `product-layout` 的内容宽度、边距和页签外层；保留现有主题和卡片表面。用量新增精确会员周期、功能筛选、每日 / 累计、服务趋势和任务钻取；CSV 使用相同时段与功能。小屏筛选整行排列，任务表明确限最近 200 条，消费聚合覆盖整个时段。

语法检查通过、686/686 整站回归、46/46 商业专项；四页桌面 / 322 px 手机、英文深色代表实页和实际 CSV 下载已检查。无新增依赖，价格及费用规则未改，真实收费关闭。当前截图和边界见实施记录的“布局统一与 Vercel Usage 参考”检查点。


### 同日实页复查：会员 / 充值 / 账单

原位修正账户折叠区内边距、手机三档权益表、账单金额单位换行和套餐说明末字换行。四页在实际 1,220 / 769 / 322 px 下复查共同边界，无内容横向溢出；三页桌面与手机、展开区及英文深色权益表截图见既有验收记录。仅 CSS 修正，语法和 46/46 商业专项通过，前一整站 686 项保持历史检查点。真实收费关闭。


### TradingView Lightweight Charts（5.2.1）

策略配置与“我的交易”使用官方 Lightweight Charts，其他统计图继续使用原 ECharts。库在本机依赖中锁定，自托管，不需要 TradingView API Key。版权见 `vendor/tradingview-NOTICE.txt` 与 `vendor/tradingview-LICENSE.txt`。

- 市场图：当前仅 Binance 现货 USDT 交易对；1m、5m、15m、1H、4H、1D，成交量与可关闭 MA20。REST 走现有 `/api/market-hub?resource=candles&symbol=BTCUSDT&interval=1m`，WebSocket 走官方公共行情域名。按品种/周期缓存、校验 OHLCV、取消旧请求、限流退避和断线补历史。未接入的场所/合约不借用 Binance 现货冒充。
- 模拟成交：只读取当前 run 的 `flow.fills`，部分成交去重后按模拟秒聚合，点击买卖点查看数量、价格与订单 ID。已有成本/计划止损/计划止盈单独标线，不表示真实交易所保护已生效。无成交时保留空态，不从订单状态造点。
- 行情时间按全站 `formatDataTime` 显示，内部保留 UTC；模拟回放单独使用累计时钟，不叠到当前真实市场图。数据刷新和切换不会提交订单、扣积分或修改策略参数。离开页面取消请求并关闭订阅。
- 图表支持键盘读数/缩放、放大查看与响应式布局。运行 `npm run check`、`npm test` 检查；真实设备与预览验收状态以对应任务记录为准。

继续沿用4188：`npm start`。以上是只读行情与现有模拟账本的图表接入，不是实盘执行授权，也不包含 Pine Script、Advanced Charts 或 Trading Platform。

### 同日 Landing Page 样式对齐

AI 积分四页与确认弹窗按现有 Landing Page 调整中性配色、胶囊按钮、细彩色选中线、反色筛选和青色焦点，保留共同外层与四项入口；修正弹窗按钮宽度和手机页头挤压。仅 `commerce.css`，未改费用 / 权限 / 账本逻辑。语法与46/46商业专项通过；Chrome实际检查1440/769/390/322 px及明暗代表页，内置浏览器后段控制超时使用Chrome完成，独立模拟身份保留分离。截图与检查边界见既有本地验收的“Landing Page 样式与选中态对齐”，真实收费关闭。

### 同日用量 / 账单最终实页复查

用量与账单已检查 Pro 有记录 / Free 空态、深浅色、选中 / 焦点、桌面及390/322 px手机；修正空态和预算短说明单字换行，仅两条 CSS 换行增强。语法和46/46商业专项通过，计费 / 权限源码未变，真实收费关闭。最终八张 Pro 账户截图见既有验收文档“用量与账单实页复查”及原任务 layout-unification/landing-alignment/usage-billing。
