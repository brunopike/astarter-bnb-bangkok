# R1：机会与策略推荐的离线合同

范围为 DTO、来源时钟、风险/能力投影、版本和缓存约束，以及既有研究结果的只读装配。不是选策模型、指标计算器、持续扫描、HTTP 推荐服务或交易执行。上游为2026-11-08《Astarter_机会识别与策略推荐接口_v0.1.md》；原18家族、S02-VP、Q01和策略公式不改。

## 实现入口

路径相对 `services/engine/src/stark_trading_os/`：

- `domain/opportunity_recommendations.py`：封闭DTO、`build_recommendation`、`read_cached`、`to_wire`及至多50项的列表合同。
- `control/research/opportunity_reader.py:read_recommendation`：显式调用一次原 `ResearchService.read`，沿原 DAL 的私人身份/只读事务读取 `WorkflowView`，复核manifest/job/scope/instrument后投影。不会调用submit、run_once、recover、cancel或executor。
- 原 `ResearchService`、Postgres DAL、表、路由、Q08/S03执行源码均不修改。没有新账本、缓存存储、provider、定时器或常驻进程。

Python内层 `AstarterRecommendationProjection.r1`保留经过校验的输入、profile和风险上下文；它不能直接当公共HTTP响应。`to_wire`白名单生成扁平 `StrategyRecommendation.v1`，不输出内层context、内部rawFile或账户余额；未知assetId/合约地址及私人金额保持null，不猜别名、库存或数量。当前没有注册GET或公开服务，现有BFF行为不变。

## 只读与权限

- 输出始终 `OFFLINE_REFERENCE`，`executionAuthorized=false`；线格式另固定`paymentAuthorized=false`、`mandateId=null`，保护语义保持。profile/DTO/hash不是可信签名或执行许可。
- 只有明确注册且配置匹配的 `S01-SIM@paper-v1`、`S02-SIM@paper-v1`可在完整合成输入下标`preparable`。这只表示本地配置可进入草稿，`nativeAccepted=false`；其他模式或假想SIM版本不能通过一个configurationPassed标记启用。
- PUBLIC只接受可共享PUBLIC/PLATFORM证据；PRIVATE/BYOK或其他账户证据不能进入公共结果/缓存。私人缓存沿原 `PrivateScope` 的tenant、principal和account隔离。真实身份与授权仍由原DAL负责，直接构造纯DTO不产生读取权限。
- 原Q08受限于LOCAL_PG17/OFFLINE和FixtureExecutor的门禁保留。R1桥接不把它变为Neon实时研究或模型工作队列；不存在产品模型调用。

## 来源与时间

每份证据保留完整recordId/taskId、sourceId/revision、instrument、内容/原始hash区别、事件/接收/可用/确认时间、窗口、期限、许可与覆盖。旧研究记录只有内容hash时，`contentHash`照录而`rawHash=null`，因此保持研究状态，不能冒称供应商原始回执。

`SourceClockV1.availabilityKind`明确两种旧边界：SOURCE表示来源可用先于本机接收；PRODUCT表示本机接收先于产品可用。不修改原Q01或transport校验，也不交换时间值迎合某个顺序。缺事件、接收或可用时间保持null并阻止准备；REST盘口的接收时间不补成事件时间。UTC、REPLAY、SIM使用显式epoch与毫秒单位，不能互算或自动将秒换成UTC。generatedAt是生产者首次UTC时间，既不改写成SIM/REPLAY时间，也不与SIM/REPLAY now作大小比较；内层publishedAt和公开provenance.decisionAt属于明确标注的数据评估clock。

`dataAsOf/asOf`取本次全部必要证据中最旧已知事件时间；有事件时间未知时为null。`expiresAt`是机会、证据期限/最大年龄、许可、fit profile和风险期限的最早边界；部分输入期限未知时它只表示已知上界，仍为research。精确到期即blocked，generatedAt、缓存命中和刷新均不续命。

## 确定性状态与可追溯依据

`research/preparable/blocked`由程序重算，调用方不能提交一个伪造的ready标记。缺版本/时点/条件/数据/成本或未核能力保持research；过期、撤回、已知冲突、风险硬锁、方向/市场冲突及费后不可行优先blocked。retain不产生方向或新策略，watch不准备入场，下跌不自动替换为DCA。

条件只接受注册op、profile内完整ruleRef{id,version,hash}、绑定证据和确认时点；FAIL阻止准备，UNKNOWN不能当PASS。对外显式映射TRUE/FALSE/UNKNOWN，不用fit profile版本冒充规则版本。数值使用带单位的十进制字符串，profile列出的参数全部必需且边界一致；对外仅输出key/value/unit/evidenceRefs。rationale/notSuitable为带evidenceRefs的有界纯文本，不执行代码或HTML。已观察的费用须有费用证据；已知边际不抵费用时，即使其他成本仍UNKNOWN也阻止准备。本地fixture费用始终标假设，不是交易所费率。模型判断不成为凯利胜率或仓位。

现有本地S01/S02版本只支持SPOT；一致改写candidate、evidence和profile的市场也不能启用PERP/CHAIN/LP。完整中性S01网格可准备，不能要求先将neutral改成long。coverage.requiredData取原catalog要求，providedData单列实际输入；缺任一必需源、无证据或未知catalog都不能complete。UTC/unix同域仍检查generatedAt不晚于首次publishedAt；SIM/REPLAY继续不与UTC生成时间混比。

桥接复核旧研究bundle和当前状态；取消、未知、失败或数据不当前的结果不能从历史bundle复活。其证据、时钟、private scope及完整job身份来自原service/DAL，不用调用方的来源替换它们。

## 身份、版本和缓存

逻辑recommendationId绑定scope、完整交易标的身份、机会锚、家族/variant及clock epoch；源或规则变化产生新版本，而不是把同一机会伪装为另一家族。内部semanticHash/cacheKey绑定证据、规则、参数、profile、模型路由和风险版本，不含刷新/生成时间。首次编译冻结generatedAt及publishedAt，revision也绑定这两份首次发布元数据；同一语义的重投走read_cached返回原产物，不用新的now或generatedAt重新发布。

对外contentHash复用既有CanonicalJSON.v1，对完整不可变StrategyRecommendation.v1（排除contentHash）计算SHA256，不再复用内部语义hash。历史status/reasonCodes/canPrepare及generatedAt保持冻结；GET式输出在同级另附currentEligibility{status,reasonCodes,evaluatedAt,clockRef,canPrepare}，该读时对象不是不可变DTO的一部分，验证内容hash时一并排除它。当前资格只能保持或降级，不能靠时间流逝把已发布research/blocked升级为preparable；采纳必须检查currentEligibility与正式私人批准，不能仅看历史canPrepare。

`read_cached`及`to_wire`必须获得可信调用方提供的`current_candidate`；没有当前head的时间型命中不成立。源修订/撤回或profile/风险/路由变化时，缓存读取返回BINDING_MISMATCH；to_wire可保留原历史内容，同时将currentEligibility置为RECOMMENDATION_REVISION_CHANGED/blocked，不暗换新版。跨scope仍直接拒绝，也不允许在发布的数据时点之前读取。没有改写旧对象、续期、扣费或新研究。R1没有建立持久head或历史GET服务；R2接服务时还须从可信源/发布层取得当前head并原子去重，不能把客户端回传的旧摘要当当前证明。

## 本轮验证边界

定向测试覆盖字段/单位/版本、未知时钟、迟到与过期、条件反证、PUBLIC/PRIVATE/BYOK、缓存当前head与不可续期、伪造派生状态/授权、实际ResearchService.read委派和拒绝、取消/UNKNOWN恢复，以及冷导入零网络/数据库/调度。

桥接测试保留真实ResearchService和纯研究合同，只替换慢/外部的repository read为受控WorkflowView；未运行真实PG、Neon、现用DB、HTTP端到端、模型或扫描器。原相关研究/预检/身份单元组一起验证。作者计数和静态检查不替代独立审查；候选和最终结论留在项目现有后端交付记录。

Q08/S03继续暂停，R2/R3/R4、C2正式授权、前端采用/历史版本UI和真实执行不因本轮自动启动。
