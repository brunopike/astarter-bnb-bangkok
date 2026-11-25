# 历史回测的前端消费合同

状态：APPROVED_FOR_LOCAL_IMPLEMENTATION_BY_DELEGATED_DECISION。2026-10-24；基础HEAD `6828498`，已验收Engine源 `651ca3b`（3417项）。用户已授权继续实现并由Codex处理阶段决策与review。

## 目标与已有事实

完成F2B4的数据发现、结果摘要、BFF和类型化浏览器客户端，使后续页面能消费真实历史HTTP。当前旧页面只使用v1工程验证工具；HIVE v0.25在另一工程由前端会话维护，仍为CSP禁止联网的模拟界面。此计划不更改该工程，也不新建第二套HIVE界面。F2C页面接线是下一消费方，不能据本计划宣称已完成。

用户目标仍是18角色、策略广场与AI搭积木的完整模拟产品。本阶段连接其原生回测基础，不以工程SMA代替S03或其他策略，不改变真实数据、私有账户、云端和持续PAPER的验收范围。

## 方案与判断

考虑直接让页面下载所有原始报告、另建业务数据库/代理、复用现有权威增加薄投影三种方案。Codex选择第三种：目录只读现有发布记录，报告摘要由已封存的原始报告提取，BFF继续既有本机Host/Origin校验和固定上游。原始下载仍保留。理由是避免浏览器为展示摘要解析最高128MiB报告，也避免引入第二套生命周期或余额算法。

所有实现沿用当前隔离工作树、Python3.12.4/Nautilus2.0.0rc3/FastAPI/SQLite schema5和Next16/React19/TypeScript。无新依赖、数据库迁移、已有服务启用、网络数据下载、Key、付费、部署、push/merge或清理。

## 1. 已发布数据发现

新增默认关闭的 `GET /v2/historical/catalogs`（after_revision可空，64位小写hex；limit默认20，上限100）与 `GET /v2/historical/catalogs/{catalog_revision}`。复用既有数据库行/发布身份/审计验证。没有任意路径输入、目录扫描、网络抓取或发布动作。

分页先按主键范围定位游标，最多读取limit+1个已注册数据库记录（含PUBLISHED/PREPARED/INTEGRITY_FAILED）；前limit个构成扫描窗口，额外一条只判断next_cursor。仅对窗口内PUBLISHED记录做审计/身份验证，未发布与v1记录不进入items，故items可能为空而next_cursor非空；客户端继续游标即可，不把空页当作全集为空。游标是扫描窗口最后一个revision，不依赖当前记录是否仍存在；新增较小revision不保证出现在本次翻页，刷新从头读取。一次读取在同一SQLite只读快照内完成。

条目包含 `dataset: HistoricalDatasetBindingV2`、source_label、source_market、source_symbol、price/size precision、price/size increment、minimum_quantity、published_at_ns，及固定 `authority=CONTROL_SQLITE`、`filesystem_verification=NOT_CHECKED`、`current_eligibility=NOT_RECHECKED`。不返回来源路径/origin、原始CSV、catalog文件路径或完整原生指纹。SYNTHETIC_QA与HISTORICAL_MARKET保留原值，不推断授权或盈利适用性。

已知revision不是已发布v2时404/CATALOG_UNKNOWN；损坏的已选数据库记录409/CATALOG_INTEGRITY_FAILED；存储暂时不可用503/CONTROL_UNAVAILABLE。读取不调用可能标记失败状态的publisher.revalidate、不改数据库、不恢复目录。之后发布配置/预检继续进行原有真实文件与环境校验。

新增 `GET /v2/historical/strategies`，只有已启用服务才返回一条固定工程定义：`sma-cross-long-flat@v1`、ENGINEERING_BASELINE、BACKTEST、HISTORICAL_SMA_V2、ENTIRE_PUBLISHED_CATALOG、`live_available=false`。name为“SMA 多头/空仓工程基准”；它表示已实现的HTTP工作流，不保证当前环境、数据或容量通过预检。金额、费用与风控参数仍由明确配置提供，不暗设策略建议或激活旧v1目录项。

## 2. 已校验原生报告摘要

新增 `GET /v2/historical/runs/{run_id}/report-summary`。必须先通过现有完整封存根及独立DB锚点校验，然后提取同一已校验report原始字节；读取不能补锚点、重算PnL或写回结果。可完整读取的COMPLETE_PASSED与COMPLETE_FAILED分别返回真实状态；合法诊断前缀或NO_REPORT缺少完整report时404/REPORT_NOT_PRESENT；损坏409/ARTIFACT_INTEGRITY_FAILED；尚未封存409/ARTIFACT_UNVERIFIED。v1运行不进入解析器。

响应为闭合DTO，包含run_id、原生report_status、report_validation、report/component/anchor/seal摘要、input/config/catalog/cost身份、account_id、observed_at_ns、verification常量、consistency_failures、四张原生表的行数，以及最后FINAL_POST_RUN检查点的字段投影。

最后检查点包含sequence、clock_ns、bar_ts_event、balances（total/free/locked）、realized/unrealized/total PnL、mark_values、total_equity的逐币种向量、base_currency_equity=null、stale/unpriced标记、positions及pending_orders的数量。金额保持原规范十进制字符串，时间保持纳秒字符串；不把不同币种相加、不用账户表排序猜最后余额、不把PRE_INTENT当成交后状态。不完整或失效证据不得返回零值摘要。原始完整表格和报告下载继续使用既有artifact白名单。

## 3. 本机BFF与客户端

在现有Next应用增加 `/api/v2/historical/[...segments]`，只允许上述和已验收历史API的精确路径、方法、ID、查询键及artifact名称。固定上游仍为配置的loopback Control；不接收完整URL/路径透传。路径合同约束Next规范化后的segments；原始点段可能先被框架规范化成合法路径，本轮不宣称原始请求目标逐字拒绝。规范化后未知路径404，已知路径不支持方法405（含HEAD/OPTIONS）；所有请求先经过原有本机authority检查，变更要求同源。v1行为不变。

配置变更不接受Idempotency-Key；预检/start/cancel必须提供1–128位可见ASCII单值。Web Headers会合并重复值，BFF额外拒绝逗号（包括合并值）以避免伪装单值；直接Control原合同不变。请求体最多64KiB、合法UTF-8 JSON，超限413；不读取或转发Cookie、Authorization、上游任意响应头。响应保留原字节、状态、Content-Type/Content-Disposition与no-store。查询只允许每项一次，按各端点白名单处理；不跟随重定向。

生成类型来自现有OpenAPI导出，不能手改生成文件。新增独立 `HistoricalApi` 浏览器客户端，使用现有requestJson/jsonMutation/失败描述；按命令接收显式幂等键，无隐式重试或自动产生第二次开仓。创建草稿超时先读回，修改CAS，发布同revision复用；202原回执与GET当前状态保持不同类型。创建/更新成功回执须与完整提交配置逐值相等（不依赖JSON成员顺序，更新排除expected_revision）；分页核对严格升序、请求游标之后、数量上限和继续游标前进且覆盖最后条目。资源响应至少核对请求身份和v2合同身份；纳秒/金额不转换成JS浮点。报告下载URL只由合法run ID与artifact枚举构造。

浏览器接口覆盖能力/定义/目录分页与详情、草稿分页/读写/发布、配置分页/读回、预检/读回、start、run、events、cancel、artifact索引、报告摘要和下载链接。页面负责呈现版本失效、结果未知、状态/证据区别；本计划不伪造页面验收。

## 4. 验收与协作

Codex唯一实现者，整阶段一次独立源码review。按TDD实现非平凡行为；不对文档和简单转发逐项造测试。测试使用新临时数据库与合成bar，真实原生子进程。关键覆盖：分页混入v1/空页/坏审计、只读不修复、摘要真实979.8 USDT与stale、缺报告/字节篡改、BFF路径/查询/方法/authority/重复header/字节保真/超时、客户端身份与重试提示。

最终固定候选运行受影响Engine和Web完整套件、strict mypy/Ruff、TypeScript/ESLint、生成类型一致性与Next构建；实际loopback HTTP经Next BFF走目录→配置→预检→202→原生执行→当前状态→已校验摘要与原字节下载。测试服务器使用新建任务目录，显式记录PID和结束状态，保留日志；不得启用已有runtime或覆盖既有数据。该smoke是服务集成验收，无可见页面/UI验收声明。

当前Cursor Grok文本校准通过，源码工具能力未验证，无代码租约。本计划不重复探针或购买额度。验收后原位更新后端交接和任务状态，前端作者可按合同接线；公共/私有角色、S03、真实数据源、云端容量继续保持各自未验收状态。
