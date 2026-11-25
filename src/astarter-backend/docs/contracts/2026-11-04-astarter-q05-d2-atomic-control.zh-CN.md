# Q05-D2 离线原子控制：finish1 库级候选

状态：**库级合成候选，待 Root 独立审查；不是产品可激活候选。** 基线 `e9a0f92864c8770e061612ad3b915f1aa23003d2`。首轮 INCOMPLETE 原字节证据保留；以下说明 finish1 新增实现，不以首轮605项替代最终字节验证。最终是否固定 clean commit、去重用例数及真实命令以 finish1 verification 为准。

## 已实现的窄差异

- `reserve` 在幂等返回前检查 bound controller lease、严格整数 fence/epoch/sequence；同账户机会键的摘要加入不可变 binding ID，异 binding 不再误报成功。原始 epoch 的相同请求可只读重放，不能再占款/审计。旧实例或旧 fence 拒绝；合法新 generation 通过当前 owner 与准入检查后，可以只读取得原 receipt。后续发单仍须通过原意图状态、锁和撤销门禁，不能据此重新占款或重发订单。
- `transaction_service.py` 承载两个独立边界：controller 归属与 backend admission。身份在构造时、事务外解析一次。缺失不自动认领账户或采用最新 DB fence；只有身份仍不能占款。
- 账户 scope 复用 D1 `astarter_strategy_scopes`。只有插入全新原生账户的同一事务能够建立 scope；其 tenant/account/environment/venue_session 与注入身份精确对应。仅 OFFLINE。旧未分配账户不会被接管工具自动认领。
- owner generation 复用 `astarter_accounts.controller_fence` 与既有追加审计 `D2_CONTROLLER_LEASE`。每个公开 mutation 在 `BEGIN IMMEDIATE` 内同时核对 account scope、实例固定 owner/fence 和最近 lease 事件。无需新现金/成交/PnL账本。
- `begin_recovery` 用调用实例持有的 generation 作 CAS，保留锁/占用，只在真实 COMMIT 成功后更新本实例 token。另一个旧实例即使提供最新 DB fence 也被拒绝。当前只支持同后端 owner 身份的 generation 交接；跨 owner 的特权转让未实现。
- finite runner 明确注入 `SyntheticControllerBackend`；恢复子进程必须携带 tenant/session/owner/expected-fence。参数不是认证系统，CLI 只供本机合成 fixture。runner 不再每次从 DB 取最新 fence 当写权。
- native capture 留在锁外，必要的纯本地 source.verify 在锁内复核；`astarter_facts.py` 不变。

## 复用及 schema 判断

金额/预算/占用/partial/UNKNOWN/保护/退出/settle 仍由现有 service 与 Q03 Fraction 计算完成。全部真实现金、成交来自原 `NativeFactsSource`。D1 `RestoredRecovery`、current 标志、raw state_policy 不参与清锁、退款或生成订单。

owner 身份仍复用既有审计序列，未重新实现。D1 episode 已有 scope/account/plan/revision/binding，但 binding 可空且没有 approval/经济 intent/current/revocation 关系，不能单独承担准入。因此008只新增：

1. `astarter_admission_heads`：每账户固定用途/后端authority、当前准入ID与generation。迁移不认领旧账户。
2. `astarter_admissions`：不可变后端状态版本；scope/account/binding/episode/plan/revision/approval 的复合FK，generation唯一；依赖摘要、policy摘要、期限和READY/REVOKED/DEPENDENCY_CHANGED。状态改变追加新版本，旧版不可修改/REPLACE/删除。
3. `astarter_intent_admissions`：intent与account/binding/admission实际外键；与资金、order、audit在同一事务提交。

三个必要UNIQUE索引给D1 episode/approval和既有intent提供精确复合父键，不改001–007或D1仓储。新表STRICT/WITHOUT ROWID。旧表/数据/trigger原样保存；新增schema8 prepare-time能力门禁覆盖所有表及零行写。database沿exact-schema前检、锁内复检、事务DDL、FK/integrity后检和真实COMMIT；现用库未打开。自动升版代码不构成生产迁移授权。

## 准入与调用合同

- `BackendAdmissionSource` 是受信任后端组合根注入，不是请求DTO或已实现认证。`resolve_context/resolve_update` 只在事务外调用；`refresh_admission()` 不接收调用方批准参数，在Control写事务中核owner/fence与generation CAS后发布持久状态。依赖/撤销的生效点是该状态发布COMMIT；未接远端依赖监听器或真实issuer。没有异步源状态在写事务中临时回调。
- `reserve(..., admission_id=...)` 的ID只选择已发布记录，不授予权力。同事务重新读取head、状态/期限、最新D1 plan、对应私人approval、spec/episode、完整依赖树、binding/policy、owner/fence、risk_epoch、所有旧版账户占用与锁。普通OFFLINE_REFERENCE与ELIGIBLE本身永远不产生准入。
- 相同key异binding/plan/revision/准入ID冲突；同一重放仍核准入撤销/期限与owner/fence，不重占款、不重复audit。新ENTRY claim也重核；保护/退出/对账/结算不依赖新批准。
- 用途持久封闭：`LEGACY_FINITE` 仅旧fixture，runner明确注入；`PLAN_FINITE_ATOMICITY` 仅D1关系与有限经济意图的合成测试接线；`Q01_PRODUCT` 永远阻断。缺来源、换用途/authority、伪造ID不能走旧入口绕过。
- 只支持已存在BTC/USDT.SIM、现货、USDT费币、0.01 tick/0.00001 step与最小base量、0.001费率，及完整默认SimulationPolicy；5 USDT最小名义沿既有风控限制。非此映射拒绝。D1/Q01的S03引用在这里只作依赖合同检查，不执行EMA/RSI/ABC，也不把旧`ASTARTER_BTC_NATIVE_SIM_V1`改名为原生S03或新组合。研究/组合/其他品种保持阻断。
- 全部Q01/D1及reservation的`execution_authorized=false`保留。没有19策略执行器、产品按钮、私人用户permit、F5/Task4/D3/HTTP/auth/真实签发服务。
- D1 raw恢复投影不清锁。新revision不能消除旧UNKNOWN/资金义务；同owner recovery可接管generation，跨owner特权转移未实现。研究三预算只留D1引用，不转入USDT交易资金。
- 原生来源固定SIM-001。不同账户反例使用明确的合成D1账户/FK与公开scope门禁，不宣称存在第二个真实native账户适配。
- 快路径0LLM，新增生产逻辑只做本地类型/哈希/Q01纯检查/SQL；capture与后端解析均锁外，沿既有有界SQLite busy handling。无OS网络沙箱、延迟SLA或真实连续交易结论。

## 验证规则

实际命令、exitcode、日志、RED/GREEN、最终源码SHA与去重身份在TASK `q05-d2-20261104-finish1-*`。首轮证据只读。finish1先在继承dirty字节跑身份/普通reference两项语义RED；另以`git show BASE:service.py`在内存载入真实BASE服务，对新建合成库取得同样两项“未拒绝占款”RED，无工作树回滚。该BASE服务探针复用当前冻结依赖/新库连接，非完整历史环境重建。

新增覆盖：真实D1关系与FK/不可变约束、缺/伪造/未来/过期准入、source与调用者DTO区分、scope/账户隔离、同key异plan/revision/admission、全账户旧版占用与UNKNOWN/锁、真实原生fill后撤销/过期仍保护退出结算、两个独立连接的撤销/换版/依赖变化竞态（并发及两种确定先后）、发布与reserve真实COMMIT拒绝及中断全回滚、合成v7迁移/旧writer/两进程与兼容。原owner测试不重写，最终回归保留全部断言。

记录的准备修正包括新增测试误把claim_cancel布尔返回当None、schema未来版本预期漏同步、工具patch唯一匹配拒绝与Ruff格式问题；不冒称这些为生产根因。最终源码后重新跑原605目标范围加新测试与schema兼容、strict mypy/Ruff，再固定本地commit交Root两路独立审查；不推送或进入下一包。
