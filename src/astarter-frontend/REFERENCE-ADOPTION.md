# MMDock / ValueScan 代码采用记录 · v0.22

仅在 HIVE 原工程适配；两个参考工程未修改。当前没有接入其真实服务或账户。

## vendor/mmdock/range-window.mjs

来源：`/Users/mac/Documents/AI Space/Developer/交易大法/工程/mmdock-frontend/components/chart-ui/range-window.mjs`

原样复制，图表窗口 clampRange / adjustRange 直接调用。

源 SHA-256：`41741fb7fced0cfeea7125669f63a9a25af44efb6f643c836940a29d57f30b06`

采用文件 SHA-256：`41741fb7fced0cfeea7125669f63a9a25af44efb6f643c836940a29d57f30b06`

## vendor/mmdock/report-visuals.mjs

来源：`/Users/mac/Documents/AI Space/Developer/交易大法/工程/mmdock-frontend/components/data-warehouse/report-visuals.mjs`

原样复制，资产核对 contributionModel 与构成 rankedModel 直接调用。

源 SHA-256：`57be2eeadf7b26168798888dd88f4c7ee057912119c869e42f1320822ba99667`

采用文件 SHA-256：`57be2eeadf7b26168798888dd88f4c7ee057912119c869e42f1320822ba99667`

## vendor/valuescan/token-fixtures.mjs

来源：`/Users/mac/Documents/AI Space/Developer/交易大法/工程/valuescan-local/data.mjs`

提取 AS_OF / DATA_LABEL / tokenRows / TOKENS 段；保留合成数据声明，独立研究样本。

源 SHA-256：`f686108e7a18cabea144212794b3fefb98b80ea44a3b07e23977f0fd1c8fa897`

采用文件 SHA-256：`77ec457da774a311102b16ab0dce91e7526319feefe709f39fae90a0500f6d6e`

## 原生界面适配

- `reference-surfaces.mjs` 的资金扫描移植 ValueScan `app.mjs` dataView 中的时间窗系数、现货/合约示例换算、流入/流出分解和方向条，保留资金排行、搜索及排序。舆情分布沿用其 sentiment 分布演示公式。不是官方 ValueScan 数据。
- AI/链上追踪表采用 ValueScan 的紧凑列表层级，接回 HIVE 既有证据 ID、关注、详情与送往研究操作；未采用模拟收益/回撤作为策略业绩。
- 资产拆解采用 MMDock `report-visuals-ui.tsx` 的总额公式与独立费用刻度，DOM 适配；费用从同一会话账本读取，未再扣账。
- 图表采用 MMDock 范围计算模块，原生双端拖动手柄、概览和平移。原有 `product-charts.mjs` K线/Sparkline 来自 ValueScan 本地 `charts.mjs`，已有配色、宽度和读数适配。
- Next/React/next-intl 未迁入原生模块工程，因此不是完整拷贝页面或复用服务端。`product-polish.css` 统一现有深浅配色及手机排版。

## 动作和事件边界

`coordinationJobs(model, trade)` 读取当前研究 runId、证据、信号 id、订单 id。证据携回优先，其次是信号风控、订单交接、成交复盘，最后才是已有样本的日常复核。每个角色同一时刻最多属于一个任务。日常轮换没有新增研究证据、结论、订单或成交。

六组采用 16 秒错峰循环；四组每次仅派一位采集员，其余在组内等待/核验，两组围桌讨论。组内一份资料逐人交接，然后由代表递交。行情图为明确的 market 来源锚点，盘口为 orderbook 锚点；手机保留行情图。

`createCoreReactions` 只消费视觉时间与既有阶段：关注递交者、低头阅资料、筛选时侧倾思考、结论就绪时轻点头。目标短暂锁定、姿态平滑过渡，不加文本卡。暂停/低动态遵从同一时钟。反应不是新增 AI 判断。

接真实引擎前必须由正式事件适配器提供稳定 run/task/evidence/signal/order 标识和时间，替换模拟来源；本轮没有做此接入。

## v0.26 页面工作流与外部参考

本轮继续沿用同一原生前端工程与原有账本，没有拷入外部网站的代码或真实数据。

- [SoSoValue ETF 页面](https://sosovalue.com/assets/etf/us-crypto-spot)：借鉴总览数值、时间窗、累计/当期口径与逐项明细的阅读顺序；HIVE 市场页仍使用合成行情与固定资金样例。
- [CoinGlass 清算页](https://www.coinglass.com/liquidations)：借鉴时间筛选、状态分组、表格与概览并列的方式；HIVE 未引入清算数据或实时告警。
- [DefiLlama 指标目录](https://enterprise.defillama.com/metrics)：借鉴同一指标必须写清定义与覆盖范围的原则；HIVE 资产页、日志页继续标注成交价估值与费用口径。
- ValueScan 的资金与链上追踪表达此前已移植到 `reference-surfaces.mjs`，当前追踪页在手机上改为证据卡，仍指向同一固定样例、证据详情与研究交接。
- 本地 MMDock 的 `report-visuals.mjs` 和 `range-window.mjs` 仍按本文件上方的 SHA 记录复用；账本明细、图区和移动端排版在 HIVE 中重新适配。

新设定页用五个整屏步骤决定范围、资源、策略模式、风险积分和启动。发现/策略/执行/积分沿同一模拟状态流转。执行通知排除旧版重复恢复提示；手机追踪与委托记录变为可读卡片。跨页协作核心的动作随页面语义切换，点击展示辅助说明；这些动作不产生研究结论、积分扣费或真实委托。

英文切换覆盖新的设定步骤、主要页面说明与操作控件，并在切换时重新渲染页面以恢复中文。策略原始合同的规则正文保留中文原文，避免自动词替换改变参数语义；英文策略合同尚未完成逐条人工审校。

## 核心接阅补充

`core-reactions.mjs` 按 evidence ID 或 job ID 锁定单次接阅，执行 attend → receive (0.65s) → read (0.65s) → think (0.85s) → acknowledge (0.75s) → release (0.35s)。复核背景动效按视觉时钟换算为接近实际秒数，不影响研究时钟。方向按交接半径归一化，转向幅度最高约 27°，思考侧倾约 11°。递交者在原交接点等待，资料与核心共享同一个 receipt 和阶段；点头代表已阅，不产生策略授权。暂停保持姿态和资料位置，重启清理 identity，低动态模式不播放接阅。


### v0.22 交接闭环与外围空间补充

沿用现有机器人、纸页与原生动效，无新增外部素材或依赖。`core-reactions.mjs` 用同一证据/任务身份串起 receive → read → think → acknowledge → confirm → release → dispatch → handoff → collaborate → resume；确认时递交者点头，纸页从核心回到手上，随后交给来源相关小组。新证据/风控/订单/成交复核会优先打断可选的返回讨论；无可用同伴时不随机借用其他人。纯展示状态不生成研究结论、模型输出或交易。

`coordination.mjs` 的会议站位依据画布宽度分配：中央宽度达到 650px 且非移动布局时，两个桌位进入左右空白区；较窄视口维持紧凑阵形。正文与右侧操作台未改动。验证见 v0.22/handoff-loop/验证.md。


### v0.22 多市场观察、表情与流线范围

复用已有 product-data.mjs 的八类资产清单，新增独立合成观察序列及归一化视图；每条曲线起点100，百分比为数值相对变化，并非收益率。黄金/美元/国债等仅用于观察，未添加交易适配。图表选择只作用于本地图表，不写入 TradingDemo 或聚焦研究。原有单盘口研究明确标注为聚焦核验，未伪装成八个独立AI研究已完成。

coordination.mjs 的六组已有样例复核标注资产范围；任务语义驱动 emoji，确认与接收优先，其余按模拟时钟错峰出现，暂停/低动态沿用原时钟。沿用系统emoji，无新增外部素材。reactor.js 外缘基准1.85→2.08，轻微扩大外圈，核心与角色尺寸未改。


## 2026-10-27 · Trading Agent Chat

- 21st MCP actual paid-tier source retrieval: **Chat with Model Menu**, Ephraim Duncan, demo `28331`, https://21st.dev/@ephraimduncan/components/chat-02 . Adapted message bubbles, assistant reply spacing, composer and attachment affordances, Enter / Shift+Enter behavior.
- **Conversation List**, arihantcodes_1f7b8c4d, demo `29936`, https://21st.dev/@arihantcodes_1f7b8c4d/components/conversation-list . Adapted active conversation rows, pinning and a compact sidebar.
- **Dialog**, efferd, demo `4371`, https://21st.dev/@efferd/components/dialog . Inspected semantic X icon and close/header geometry; native dialogs keep the existing app's focus and Escape behavior.
- Retrieved originals: `.goodway/assistant-ui-20261027/refs/28331.tsx`, `29936.tsx`, `4371.tsx`. Chat02 preview inspected in the browser. Kept existing native ES modules instead of introducing a second React runtime. These are adaptations, not a drop-in React installation.
- Removed template model picker, voice, fabricated streaming and external search actions. Actual capabilities: local sample Q&A, quoted text extraction, demo OHLC-window calculations, text attachments, local conversation history and JSON export. No model or transaction integration.
- Uses the supplied Astarter color tokens and shared navigation. This route does not modify the 18-agent collaboration scene.


## 2026-11-06 · AI Trading OS 操作交互

- 21st.dev `victor-teles / Command Menu`：读取组件源码 ID 38984（componentId 21979），提取搜索筛选、键盘选项、Esc 和焦点返回的交互方式。适配为 `ai-operator.mjs/css`，复用原生 dialog、现有图标和导航；未引入 React/shadcn、未调用托管 AI。
- Coinbase 官方周期交易流程：https://help.coinbase.com/en-ca/coinbase/trading-and-funding/buying-selling-or-converting-crypto/how-can-i-create-or-cancel-a-recurring-transaction 。借鉴金额、预览与确认的短路径；不移植其金融产品，不表示真实交易能力。
- Linear 官方 Inbox：https://linear.app/docs/inbox 。借鉴待处理动作优先于普通更新的层级。原订单结果待确认优先查询，运行中的策略优先展示当前状态；不新增执行权限。
- 问卷结果、接入恢复、策略启动、当前账户交易页及 Chat 草稿贯通；所有执行仍使用已有模拟引擎、资金保护和批准检查。当前可运行的 S03 与研究模板继续区分。
- 浏览器与测试证据：`verification.json` 位于 `photonic-vi-plan/assist-audit/os-interactions-20261106` 任务目录。


## TradingView Lightweight Charts · 2026-11-07
- Adopted official npm package `lightweight-charts@5.2.1` (Apache-2.0), standalone ES module served from the existing whitelist. `fancy-canvas@2.1.0` is its only added dependency; other installed package versions are unchanged.
- Source: https://github.com/tradingview/lightweight-charts and https://tradingview.github.io/lightweight-charts/docs . Official attribution logo, TradingView link and public NOTICE/LICENSE retained.
- Product: strategy creation and current-run trading detail. Public Binance spot OHLCV is separate from fill-driven paper playback. No account credentials reach chart configuration or public data requests.
- Verification evidence: `/Users/mac/Documents/AI Space/Developer/交易大法/任务/01a19ee2_前端协作/2026-11-07-trading-hub/lightweight-charts/`. Browser partial acceptance and remaining responsive/theme checks are recorded there, without claiming a completed cross-device release.


## Crypto market cards · 2026-11-08

- User-selected 21st.dev **Crypto Dashboard**, reuno-ui, demo ID **5479**, component ID **3961**: https://21st.dev/@reuno-ui/components/crypto-dashboard . Paid-tier MCP source retrieval verified; hosted AI not used.
- Adapted the asset/quote → 7-day trend → volume/cap/range hierarchy into the existing `market-hub.mjs/css` overview and watchlist. The existing data table remains available; Movers retains its table. Existing search, sorting, watchlist, routes, token icons, quote streaming and chart links are reused.
- Did not import the component runtime, Framer Motion, BackgroundPlus, CORS proxy, mock fallback, polling or custom chart. Its point-index chart has no source timestamps; the existing miniChart remains a summary linked to the full chart. Card 7-day history and USD cap/range remain source-specific; current price/change/volume use the existing quote provider and its quote unit.
- Final target-route and viewport evidence is recorded in N2's current task record; source retrieval alone is not rendered acceptance.
- Native refinement: one compact desktop header, explicit card/table selection, compact scope/order selectors on narrow screens, 44px controls and stable focus identity. Source details stay behind a 14px info icon in a 44px target; timestamps use the existing full UTC+8 formatter. Main quote and percentage occupy consistent rows across cards. Scoped native observations and screenshot hashes are in the N2 market-ui final manifest.


## Economic event cards · 2026-11-08

- User-selected 21st.dev **Economic Calendar**, ravikatiyar162, demo **8415**, component **5680**: https://21st.dev/@ravikatiyar162/components/economic-calendar . Actual component and demo source retrieved through paid-tier MCP.
- Adapted date navigation, horizontally browsable event cards, impact and Actual/Forecast/Previous hierarchy into existing `data-feed-views.mjs/css`. The calendar moves before the news stream on the local macro/news route; event values, dates and related assets remain the existing CALENDAR records. Source demo events, flags, hardcoded Today, generic Code2 icon and Framer Motion are not imported.
- This component supplies no economic-data API. No new provider is claimed; the separately selected live news view stays separate and receives no local calendar records. Missing Actual remains unavailable, not a synthesized result or inferred pending release.

## Dot Tiles · Louis Studios · 2026-11-08

User-directed source: https://21st.dev/@louisstudios/components/dot-tiles
Authenticated 21st component/demo ID 44768; published 2026-11-06; retrieved 2026-11-08. Official component page lists MIT (https://docs.21st.dev/@louisstudios/components/dot-tiles); see DOT-TILES-LICENSE.txt.

Upstream source SHA-256: `e41044286f9f6837856211311af9b09aa95cb847be236189327a9835ff232710`. Native adaptation in photonic-workbench.mjs directly preserves the 5×7 glyph table, dot radius/pitch ratio, slider marker/ticks, step segments, dot sizing, source blocks, and four-step rise geometry. Shared stylesheet adapts the black glass face to the official VI and about 116px compact stage height. Original square footprint, health-demo copy, random drift, count-from-zero and timed replay are omitted; values and each microchart use real current research counts. Current-phase breathing and one 160ms data-change feedback use existing pause/visibility/reduced-motion guards. No React island, dependency or new clock.

Evidence/source/preview and exact CSS handoff: /Users/mac/Documents/AI Space/Developer/交易大法/任务/01a1b83d_战队三处精修/dot-tiles-20261108. Integrated desktop and 320px first/last stage screenshots were reviewed from F1's shared browser window; the initial compact adaptation measured about 117.1px on desktop and scrolled through all six stages without page overflow at 320px. A subsequent two-line controller fix flushes the final current-data snapshot on pause; the actual update-branch regression fails before the fix and passes afterward. Integrated related checks: 67/67, including pause/resume with reduced motion enabled. The controller tracks running separately from visual motion so disabling animation cannot suppress the final data snapshot. Pause-fix source was verified against the local 4188 response; post-fix browser observation remains with the coordinator. F1 owns the user's later color and further-height refinement; the 117px screenshots do not accept that subsequent CSS.


### Dot Tiles headline numerals · 2026-11-08

`fonts/lenswave-digits-c51af0a60a7c.woff2` adapts the same original 5×7 glyphs into native selectable numeric text (2448 bytes, SHA-256 `c51af0a60a7c71dd86605466d6e4f4bc91b8f81ed0beb6f649863827d8c40495`). FontTools conversion, glyph and punctuation verification: task `dot-number-20261108/build-digits.py` and `font-check.json`. The original MIT notice is embedded in the font metadata; DOT-TILES-LICENSE.txt remains authoritative. No new product runtime dependency. `fonts/dot-numbers.css` targets headline values explicitly; financial values, precision, units, local colors and chart axes are unchanged. The top optical ribbon retains its original dense halftone canvas numerals, sweep and hover rendering, per the user's subsequent correction.
