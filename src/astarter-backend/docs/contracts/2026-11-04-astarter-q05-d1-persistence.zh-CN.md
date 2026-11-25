# Q05-D1：Q01 离线引用持久化（SQLite schema 7）

## 范围与非目标

固定输入：Q01-C `d42c7d06445d51716a5a5bbe58364cfc899f68e4`，合同源码 SHA256
`1e6d2088c1d81f2716274cbb995232fb00569dae054cbc97153cf66214e436e2`。
这是库级私有持久化切片，不是执行授权。没有 HTTP、auth、可信签发、激活、调度注册、运行导出或公共 cache 接线；不改变原 S03/SMA 解释器。

只验证源码 001–006 在临时目录合成的 SQLite；不读取/迁移现用数据库、不接 Neon/Postgres。D2 的资金原子占用、原生对账、owner takeover、订单引擎和 F5/Task4 不属于本包。

## 复用与字段差异

旧 `strategy_drafts` / `strategy_configuration_versions` 的 `content_schema` 仅允许
`StrategyConfigurationInput.v1/v2`，旧读取器按 kind 封闭。Q01 不是该合同，不能将新 bytes
写入旧表冒充兼容。本包复用旧不可变发布、请求幂等、CAS 和 Control `_immediate_transaction`
方法，通过 007 添加关系，而不是改旧 schema 或新造账本。

| 新关系 | 结构化身份和约束 | 负载 |
|---|---|---|
| astarter_strategy_scopes | scope hash；tenant/account/environment UNIQUE；account 全局唯一 FK；venue_session、authority_ref | 严格 ScopeAssignment |
| astarter_strategy_versions | scope FK；strategy/kind/version/profile/parameter_revision 复合 PK；hash UNIQUE | 原 Q01 StrategySpec |
| astarter_plan_versions | scope/plan/revision PK；ordinal、前版 FK、request key UNIQUE；plan/spec hash、risk/roles、有效期 | PlanRecord + 原 PreflightInput（不含批准） |
| astarter_approval_references | scope/reference PK；request key UNIQUE；plan/revision/hash FK；risk/roles/期限 | OFFLINE_REFERENCE + 原 ApprovalSnapshot |
| astarter_episode_references | scope/episode PK；plan FK；可选旧 binding/account 复合 FK | EpisodeReference（无伪造 run_id） |
| astarter_layer_references | scope/episode/layer PK；唯一 action；VIRTUAL/ACTUAL_REFERENCE、trigger ID | LayerReference + 原时间/权限证据 |
| astarter_recovery_checkpoints | scope/plan/revision/seq PK；前 hash FK；state/hash、causal、episode/layer FK、可选旧 audit/account FK | 状态、原因锁、原三类预算、因果快照 |

所有新关系均私有；本包没有公共 strategy/cache 查询，私人参数版本也不外泄。原 accounts、
bindings、limits、intents、orders、fills、settlements、audit 不被 repository 写入。
全 19 条 Q01 身份可归档；非 S03 不因存储而有执行适配器。SMA 不被当作新 StrategySpec。

## Scope 信任接口

`BackendScopeSource.resolve_scope()` 是**显式后端可信依赖**，不是认证实现，不是可接收客户端
任意 tenant 字符串的 DTO 工厂。后续接线必须先在后端验证账户归属，再注入该依赖。
本包只在合成 fixture 实现它，不声称已有登录、公钥、issuer 或 ownership registry。

`provision_account_scope` 是单独的受控 provisioning 操作：需要明确的既有 account + venue_session
来源，不能由普通 repository 初始化触发；007 本身不认领任何旧账户。一个旧全局 account
只能有一个 tenant/environment 归属，不能跨租户认领或跨环境复用。没有转移/撤销权限服务。
持有 Python/SQLite 任意执行权的人不在这个应用层隔离防线内。

Repository 构造时冻结后端 assignment；所有读、列表、写、恢复都限定其 scope，并校验嵌套
private/BYOK 证据一致性。没有无 scope 的按 ID 查询。列表用 plan_id/ordinal 稳定游标。

## 存储、重放、当前版本

- 所有载荷先过 Q01 原 exact-tree canonical 边界；`model_construct`、隐藏 extra、嵌套错类型不能绕过。
- JSON 数组仅恢复为合同 tuple；不转换任何 scalar、不用 float 表示金额。重新严格验证、canonical
  bytes 比较、SHA256 比较和结构化列逐项比较，拒绝坏 blob、重复 JSON key、额外字段或列/载荷错配。
- PlanRecord 将 request key、前版、ordinal 纳入 hash；同请求同内容返回原记录，异内容拒绝。
  每个 plan 追加版本时同事务比较期望前版；规则变更遵守 Q01 parameter revision 检查。
- 新表 UPDATE/DELETE 均拒绝；BEFORE INSERT 冲突检查额外阻止 SQLite 默认非递归 trigger 下
  `INSERT OR REPLACE` 绕过 immutable delete。所有 UNIQUE 路径都纳入冲突检查。
  七张新表使用 `WITHOUT ROWID`，消除未声明的隐式 rowid 冲突替换入口；不改变旧表。
- 当前版由最大 ordinal 决定，旧版不覆盖；旧批准与旧版历史仍可读取。读当前版使用旧批准时按
  原 Q01 hash/依赖匹配失败；读旧版明确 `PLAN_SUPERSEDED`，不能把旧批准继续当当前批准。
- 读 plan/恢复须传显式 now；重跑原 Q01 preflight / approval 的期限、九职责、证据权利和私有
  scope 检查。恢复的 causal 与 layer trigger 仍按**读取 now**检查 TTL/rights；另须满足
  `causal.received_at_ms <= checkpoint.observed_at_ms` 及关联
  `layer.trigger.received_at_ms <= checkpoint.observed_at_ms`。等值可接受，晚 1ms 也拒绝；
  后来才保存或读取不能补成历史上已接收。关联检查由 `_checkpoint` 供写事务和读取共用，
  写后核验失败回滚，不留下半 checkpoint，不回写任何时间。归档可以存过期/阻断引用，
  不把“保存成功”当“审查通过”。ELIGIBLE 仍只是 `execution_authorized=false` 的 offline match。

## 恢复与经济事实边界

checkpoint seq / previous hash CAS、请求重放、关联核验都在同一个 Control 写事务。
读时核对前 seq/hash，不重写记录。**同 (scope, plan, revision) 链内** UNKNOWN/PARTIAL
不因重启转成功，D1 不清既有 reason locks，不把供应商 UNKNOWN liability 改成结清。
旧链责任仍存在；新 revision 的独立快照不是全账户已恢复/已对账/已结清结论。
后续真正状态解决需 D2 明确信任来源与迁移语义，本片不实现跨 revision 聚合。

### 离线 typed 档案读取接口：不是 D2 综合恢复门禁

`read_recovery` 返回 `RestoredRecovery`，只增加结果层 metadata，不改变 checkpoint 原 payload、
hash、Q01 原投影或任何 `execution_authorized=false`：

- `reference_only` 固定为 `true`，不接受构造参数，结果不可变；不是用户可选择的运行模式。
- `checkpoint_current` 从**同一读事务快照、已限定 scope + plan + revision** 的数据库最大 seq
  计算；默认 latest 为 true，显式读取非最新旧 seq 为 false，显式最新 seq 仍为 true。
  显式 seq 是历史查询，不是恢复指令。它不等于 `RestoredPlan.current`：后者比较该 scope/plan
  的计划版本 ordinal。因此旧 revision 的最新 checkpoint 可以 current=true，而 plan.current=false。

调用方必须保留以下四项独立边界，不能将 metadata/policy 拼成执行许可或自动清锁：

1. `reason_locks` 独立保留在 checkpoint；raw `state_policy` 不合并它。Q01 frozen spec §5
   的单 plan 投影含义不变，`new_risk_blocked=false` 仅表示该状态投影未发现阻断，绝不授许可。
2. 历史 seq、checkpoint 链最新和计划版本最新是不同概念；current 只是读取快照时的局部标记，
   不是全账户 readiness、签发、调度或接管依据。
3. UNKNOWN/PARTIAL、锁、供应商未知责任的单调保持仅约束同 revision 链。旧链中的义务不因
   新 revision 表面健康而消失；D1 不做全账户风险/资金/跨 revision 对账或另一层状态引擎。
4. causal/trigger 仅验证引用 bytes/hash、scope、时间与 rights；不证明引用主体实际触发该策略，
   也不证明来源可信。主体绑定和可信来源规则是后续接线前置，不在本片内补造。

即使 `ELIGIBLE`、两个 current、状态与预算投影都看似健康，也不会产生执行/风险释放许可；
原 reason locks 和历史责任仍保留。这里没有 D2 字段、readiness 计算器或自动清锁路径。

episode/layer 为版本化持久引用，不捏造原生 run。可选 binding/audit FK 只关联已有事实，
不会生成 ACTIVE binding。ACTUAL_REFERENCE 也不是实际成交断言。虚拟 layer 没有现金/fill/PnL
字段，不生成任何经济事实；它只保存唯一层动作、触发/跳过/未知引用。

预算直接复用 Q01 SIM_MODEL_CREDIT_V1、供应商 USD/points/CU（含 provider/meter/version/scale）
和 ASTARTER_CREDITS 快照。没有余额、收费、1:1 换算；客户释放不消除供应商未知责任。
保护/退出/对账 policy 标记保持原合同，不能以研究预算不足解除旧保护或启新交易。

## 007 迁移与旧 writer

`exact-v6` 快照前检 → BEGIN IMMEDIATE → 租约内 exact-v6 重检 → 全部 DDL →
exact-v7 + FK + integrity → COMMIT。异常/取消/COMMIT 拒绝均 rollback。
并发败方只接受 exact-v7；001–006 原字节和旧 fingerprint 能力保留。

全部旧/新表三类 writer trigger 更新到 7，旧 immutable trigger 原 SQL 保持。
仅将旧函数返回值比较改为 7 无法阻止零行语句，因此新连接另注册
`stark_control_writer_schema7()`。真正 v6 连接没有该函数，SQLite 在 prepare/reprepare 时拒绝，
包括缓存语句和 UPDATE/DELETE/INSERT WHERE 0。这是二进制兼容门禁，不是数据库凭据权限。

## 验证与接收

具体命令、退出码、RED/GREEN、源码/输入/日志 hash 和冻结候选以 TASK 下
`q05-d1-20261104-reviewfix1-verification.json` / `q05-d1-20261104-reviewfix1-handoff.md` 为准。
初轮及 finish1 的提交、报告和日志保留；finish1 的作者 GREEN 未通过独立审查，不作接受依据。
reviewfix1 仅修关联 trigger 的历史接收约束并澄清上述离线档案接口。新增读边界坏记录仅在
临时合成 SQLite 中用现有私有插入 helper 注入：合法 SQL/FK，不关闭 FK、不改 trigger/007。
原不完整 checkpoint 和语义 RED 日志保留，不将旧 GREEN 当作最终字节通过。
测试使用实际 SQLite、两连接/两进程、authorizer 拒绝 COMMIT、progress handler 取消以及
源码 SQL 故障，不用 mock 结果代替 SQL 执行。既有 Astarter 短合成原生单测单独兼容；不启动服务。

作者候选不等于验收；固定候选交 Root 安排 Codex 代码/安全及规范/架构两路独立审查。
不在作者会话启动其他 agent/model，不宣称 Codex 已接受。生产迁移、D2、签发、执行、云接线
和真实长测均未实现或未授权。
