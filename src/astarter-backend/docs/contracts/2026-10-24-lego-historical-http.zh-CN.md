# 历史回测 HTTP 与后台调度合同

状态：ACCEPTED_LOCAL_HISTORICAL_HTTP；固定源651ca3b。基础源4034c4f、交接HEAD1734fcf；仅本地隔离工程实施授权。

## 目标与取舍

把已接受的内部历史链变成可供页面消费的配置、预检、启动、取消、状态、事件和证据接口。沿用Python3.12.4、Nautilus2.0.0rc3、FastAPI、SQLite schema5、现有状态机/幂等/进程所有权。所有运行仍为BACKTEST/HISTORICAL_SMA_V2，工程SMA不等于产品S03。

考虑过同步HTTP直接await execute、另建独立job表/调度器、复用共享预约和任务注册表三个方案。Codex选择第三个：同步请求只做可信预约，返回持久202；共用ApiCommandScheduler管理v1/v2有限任务，按kind进入专用合同。避免请求等待整段回测，也避免第二套状态权威。用户已授权阶段决策与连续实现，沿用Codex唯一写入和整阶段一次独立审查。

Cursor提议默认关闭HTTP先行、页面随后，已收到文本建议。用户随后切换为Grok4.7HighFast，六项修正已收到文本确认；一次有界源码工具核查无可见结果而中止，纯文本算术核查合格不等于源码接力通过。实现仍以此文档和实际源代码为准。这里额外纳入草稿/发布薄路由，因为当前仅有程序内服务，没有经核实的用户配置CLI；否则页面无法完成配置流程。这不改变已验收的配置业务规则。

## 作用域

- 同一ControlStore、数据库和状态/审计；共享任务注册、取消和关机收敛，显式v2入口。没有迁移用户既有运行库或启用默认服务。
- 默认关闭；正常服务只有明确`HISTORICAL_API_ENABLED=1`才构造历史服务。未设置或0关闭；其他值启动报配置错误。测试可明确注入历史服务。有效请求在关闭时返回503/CAPABILITY_DISABLED且不产生变更。
- v1 HTTP DTO、原字节、旧报告和纯v1并行语义保留。v2不能经过v1的输入/指标解码。新v2消费者先核对最小不可变kind，跨kind返回409/RUN_CONTRACT_UNSUPPORTED，不能写入或解析异版本文件。
- v2能力接口单独报告开启状态，v1 capabilities不改。所有能力仍无live、模型、Key或外部交易。
- 此阶段包含后台恢复和完整HTTP闭环；页面/BFF在后续阶段。数据导入/网络源、S03/ABC、连续PAPER、18角色、策略广场、H5/Kelly/资管叠加均不在这里启用。

## 路由与序列化

前缀固定`/v2/historical`。请求体extra=forbid、金额/纳秒保持字符串，ID及摘要使用已有闭合校验。预检/start/cancel必须有唯一Idempotency-Key头，使用ASCII可见字符1–128。配置草稿沿既有服务合同：POST创建返回201、新资源创建不自动重试；PUT使用expected_revision CAS，同revision发布返回原版本。配置命令拒绝Idempotency-Key而非收下后忽略，超时先读回草稿/版本，不宣称这些服务具有未实现的通用幂等收据。错误复用ErrorResponse，原始路径/输入/异常栈不外泄。

| 路径 | 合同 |
| --- | --- |
| GET /capabilities | 即使关闭也可读；enabled布尔、environment=BACKTEST、contract_kind=HISTORICAL_SMA_V2、live_available=false；不承诺服务/当前准入一定可用 |
| GET/POST /configuration-drafts | 分页读/创建历史草稿；POST直接使用SmaConfigurationInputV2，不接受文件路径、任意Python或客户端input manifest |
| GET/PUT /configuration-drafts/{draft_id} | 读/expected_revision CAS更新；配置业务复用已有服务 |
| POST /configuration-drafts/{draft_id}/publish | expected_revision，返回已存储不可变发布版本；同revision发布复用现有版本，不创建第二版 |
| GET /configurations；GET /configurations/{configuration_id} | 只读发布版本；configuration_id自身唯一标识版本，客户端不再提供第二份version |
| POST /preflights | {configuration_id}，返回已有HistoricalPreflightReceipt.v2的原始规范字节，200；重试保留原收据/到期时间 |
| GET /preflights/{preflight_id} | 原收据、consumed_at_ns、当前观察时间与时效；时效窗口不等于真实文件/准入仍可消费 |
| POST /runs | {preflight_id,request_sha256}，复用历史consume事务；返回已存储202队列收据原字节含input_manifest_hash；异步执行；不由客户端另给run_id |
| POST /runs/{run_id}/cancel | {reason}，复用共享取消事务，202/200原收据；取消意图不是零成交证明 |
| GET /runs/{run_id} | 持久状态/version/visible序号、已绑定配置/输入/成本/catalog身份、记录的process/outcome/preparation/publication状态；不从GET修改/恢复任务 |
| GET /runs/{run_id}/events | after_seq非负、limit1–500默认100，复用持久可见事件；游标不得高于尾部，不输出不可见终态准备事件 |
| GET /runs/{run_id}/artifacts；GET /runs/{run_id}/artifacts/{artifact_name} | 固定枚举白名单、每次通过现有完整finalizer重验，原字节响应；没有任意路径参数 |

配置与草稿列表以ID排序、可选after_id、limit1–100默认50，数据库分页limit+1；不存在/非法游标明确拒绝。每个返回记录仍经过已有内容/audit/发布序验证。新配置列表和列表参数属于HTTP薄适配，不另造发布规则。

公开artifact枚举固定为input_manifest、catalog_manifest、runner_exit、stderr、component_snapshot、historical_report、evidence_anchor、events、audit、run、seal；映射到现有相对路径。缺anchor/未发布返回409/ARTIFACT_UNVERIFIED；已发布但该合法诊断前缀不含某件返回404/ARTIFACT_NOT_PRESENT；完整根或DB锚点不一致返回409/ARTIFACT_INTEGRITY_FAILED，不能先返回局部正确文件。有效FAILED诊断可下载，NO_REPORT不补空报告。

状态端点的publication状态明确来自持久记录；如未做本次文件读取，不能标成“本次已重新验证”。artifact索引/下载才完成新鲜验证。整数秒/浮点不能替代纳秒或金额。客户端不接收原始input_bytes大字段作为状态摘要。

读取DTO落点为`control/historical_api_models.py`：预检状态用原`receipt`、`consumed_at_ns`、`observed_at_ns`及`time_status=BEFORE_CHECK/IN_WINDOW/EXPIRED`，`current_eligibility`固定`NOT_RECHECKED`。运行`process.claim`只说明数据库的UNCLAIMED/CLAIMED_UNBOUND/CLAIMED_BOUND，不证明进程当前活着；`publication.state`为NOT_PREPARED/PREPARED/PUBLISHED，authority为CONTROL_SQLITE、filesystem_verification为NOT_CHECKED。只有成功的artifact索引标记FRESH_FULL_ROOT_AND_CONTROL_ANCHORS；索引逐项列下载可用性、size_bytes和sha256，诊断缺件不造空文件。PREFLIGHT_READY的状态允许只读观察，执行/取消仍要求已消费预约。

## 幂等、后台任务和恢复

1. HistoricalControl.reserve仅调用已接受的消费事务；不启动进程或创建报告。run_reserved只从存储的已消费预检重建可信预约，不能接受客户端或任意RunReservation；execute保留既有reserve→run_reserved组合行为。
2. HTTP在同一事件循环内完成预约和任务注册再返回202，不await整个回测。若返回前崩溃，持久QUEUED仍可由启动扫描恢复。同键重试保持同run/原202，即使当前已运行/结束；当前状态由GET读取。幂等冲突、过期、漂移、忙碌均不创建后台任务。
3. 共用ApiCommandScheduler的任务注册和close/drain。新增历史入口不扩大旧v1-only方法；同一run同操作只注册一次，取消sidecar不能被运行owner吞掉。关闭后拒绝新变更命令503/CONTROL_UNAVAILABLE，GET/已存储收据查询在库关闭前仍可用；重新启动后同键重放不改变原响应。
4. 启动时，合法QUEUED且从未claim的已消费任务可以正常开始；已claim/已有outcome的任务走既有有限恢复，不推测未知进程已死。startup处于FINALIZING但无anchor时保持未验证和占用，不自动prepare。明确重试已接受start或cancel可以走正常prepare，前提是原字节和绑定全部通过。
5. 合法pending状态不是无限循环重试，也不伪造FAILED。新准入仍由数据库独占规则保护；读状态与必要取消不被某个未知run的“恢复等待”永久挡住。未预期后台异常记录稳定不可用原因并拒绝新变更，保留状态和证据。
6. cancel只对证明归属的进程终止；clean-no-claim无进程取消可封存NO_REPORT；自然结束与取消竞争继续用共享事务裁决。任何未知归属保持占用。正常显式cancel的准备与后台recover不得混同。

## 错误、验收和资源边界

固定错误族：503 CAPABILITY_DISABLED/CONTROL_UNAVAILABLE/ENGINE_VERSION_MISMATCH；404 RUN_UNKNOWN/CONFIGURATION_UNKNOWN/PREFLIGHT_UNKNOWN/ARTIFACT_NOT_PRESENT；409 RUN_CONTRACT_UNSUPPORTED/IDEMPOTENCY_CONFLICT/HISTORICAL_PREFLIGHT_STALE/HISTORICAL_INPUT_CANDIDATE_INVALID/HISTORICAL_CAPACITY_BUSY/STATE_CONFLICT/CONFIGURATION_REVISION_CONFLICT/ARTIFACT_UNVERIFIED/ARTIFACT_INTEGRITY_FAILED；结构错误422沿既有统一处理。当前内部输入异常未区分缺失配置与底层漂移时，不伪造细分类别；薄API可先检查ID存在再调用核心。全部失败先保证无额外写入/调度，再返回真实类别。

验收必须实际经HTTP创建/发布配置→预检→202→真实原生child→可见终态/原始报告，验证手续费、身份、只运行一次、重复/重启/取消/故障以及默认关闭。注册任务的时间和完成回测的时间分开证明，不把一次耗时测量变成SLA。持续使用新隔离临时DB/loopback测试；不启动既有用户服务、不采购API、不接触资金。

导出更新的OpenAPI并检查旧路径/schema语义保持；完整Engine与受影响合同检查后做一次独立源码审查，修复实质问题后固定源全量验收。完整接口接受不等于UI、1000用户容量、策略收益或整个产品接受。
