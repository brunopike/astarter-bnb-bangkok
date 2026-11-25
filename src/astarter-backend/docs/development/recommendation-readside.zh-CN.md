# 公共推荐只读装配（2026-11-12）

本轮两步：新增受控公共推荐读取服务，再接可选只读HTTP；复用R1 DTO、ResearchService与原DAL，不修改Q08研究/批准/预算/表及S03。这里的可运行接口是离线/可信装配切片，非持续机会扫描、模型选策或生产发布。

## 可信装配

`RecommendationReadSide(service, publications, clock_ms=...)`仅接受真实ResearchService和最多50份R1发布对象的tuple。仅PUBLIC，发布必须绑定`astarter-research-dal`的research taskId；PRIVATE/BYOK沿原R1校验拒绝，不能靠换公开标签导出。相同recommendationId不允许多个版本或重复配置：本版是一个有界配置目录，不是持久head/历史数据库。

发布对象应由可信后台通过原`read_recommendation`取得，不能从HTTP body/query或客户端缓存载入。初始化canonical校验并复制；HTTP不能改候选、参数、profile、风险、时钟或head。服务端配置固定到此装配版本，更新策略/风险政策须重装可信配置；本版不声称自动订阅全局政策或持久head变化。

每次合法读取调用一次ResearchService.read，沿原DAL核对job/scope/manifest/证据、版本与状态，再交R1.to_wire：历史内容、generatedAt、decisionAt、contentHash不变；currentEligibility单列。job换版/取消、期限到期阻断旧资格；DAL拒绝/异常不退回旧缓存成功。没有新publication、job推进、模型、资金或订单副作用。不得把历史canPrepare当当前采用许可；采用仍需既有私人批准/当前账户和策略版本核验。

## HTTP

`create_app(recommendation_readside=readside, web_local_origin=...)`显式启用专用只读应用；默认不挂推荐路由。该模式禁止混入Control factory、采集器、public-data、assistant fixture或strategy runtime，保留原LocalOriginMiddleware。仅借用readside，连接池/Service由调用者拥有，工厂不隐式连接或关闭它们。

- `GET /v1/strategy-recommendations`：固定PUBLIC目录，稳定按recommendationId排序，最多50份，返回items及nextCursor=null。
- `GET /v1/strategy-recommendations/{id}?revision={64位小写hex}`：精确返回已装配版本；缺失/错版本404，不替换最新版。
- 列表本轮不接受query；详情仅一个revision。未知/重复参数400，无查询端候选、scope、now或current head注入。
- 读取成功和错误均no-store。原权限拒绝按404隐藏存在性，服务/校验故障503且只返回通用错误码，不返回私人异常或输入。
- 推荐专用装配的最外层也补no-store，包括原Origin拦截、method拒绝和slash重定向；其它app模式不改。只有RecommendationNotFound目录缺失映射404，DAL内部KeyError等故障仍503，不能伪装成记录不存在。
- 没有POST/启动、刷新研究或资金接口。不能用GET修复失败作业。

列表无服务端过滤/游标分页，精确详情不提供目录外历史；私人身份HTTP、持久发布去重/可信head、真实数据观察与页面接线均未实施。后续按项目产品合同另接，不用本目录伪装这些能力。必须保留OFFLINE_REFERENCE及modelCalls=0等事实，不改为live。

## 验证与边界

作者测试使用真实ResearchService/原DAL类型，仅替换其read_workflow为受控WorkflowView；没有真实数据库连接。HTTP使用FastAPI TestClient/ASGI内存协议，不启动TCP或现用服务。冷导入测试禁止数据库、网络连接和工作线程/任务启动。具体RED/GREEN、兼容、静态检查及独审证据保留在任务`recommendation-readside-20261112`。

首次pytest收集误用了虚拟环境已安装旧包，保留失败；显式PYTHONPATH=src后出现预期缺模块RED。另一个作者断言误用内部publishedAt作wire字段，已按R1既有provenance.decisionAt修正，失败日志保留；没有改变旧合同配合测试。

Q08/S03保持暂停。不接真实模型/API/Neon，不迁移现用库，不启动持续调度或真实长测；ASGI通过不等于前端、移动端、云端或实盘验收。

最终固定实现a899253：作者223项通过（38.72s）、strict mypy三源/Ruff通过；独立代码APPROVE/68项，架构CLEAR/79项及12组专门反例。原COMMENT与两P2反例/修复日志保留。末次提交仅更新本说明与实施计划的收尾状态，不改已审源码。
