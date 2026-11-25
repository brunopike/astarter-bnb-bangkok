# Q05-D3 PG2：应用仓储、连接池和最小权限

用户已授权Hermes gpt-6-astra/HIGH实施，Codex派工和审查，复用PG1和Neon隔离测试库，不迁移现用库、不接实盘、S03暂停。本设计细节由Codex根据现有调用链选择，不额外开启产品方案审批。

## 可验收结果

PG2接通已完成的Q01-C/D1应用仓储链：策略版本、计划版本、私人批准引用、episode/layer引用和恢复检查点。真实Python Psycopg3＋ConnectionPool，通过显式opt-in应用组合根使用Postgres，复用D1相同公共模型/校验/方法语义。不是通用SQL执行器、sqlite兼容伪装或另造资金账；原ControlStore/AstarterControl/资金执行/旧HTTP默认组合根继续SQLite。

### 范围与接口

- 新PostgresStrategyRepository(pool, source: BackendScopeSource)，覆盖原StrategyRepository的save_plan/save_approval/read_plan/list_plans/save_episode/read_episode/save_layer/read_layer/save_recovery/read_recovery全部公共方法的输入/返回/错误语义。scope由可信后端source注入，不从任意请求dict/SET tenant产生权限；每事务检查原binding/版本/内容/hash/因果与current/reference_only状态。
- 最小显式应用工厂构造仓储＋池并管理关闭；默认依赖工厂不切换、不发现/读取control.sqlite、无服务端口/前端改动。
- 原D1纯模型、canonical bytes/hash、Q01判断与解码校验复用。允许对原strategy_repository.py做必要纯codec提取或通用row输入类型调整，原SQLite SQL/事务/公开API/判断不变；不复制一套Q01规则。
- Psycopg3同步接口匹配现有同步仓储。依赖固定psycopg[binary]==3.3.7、psycopg-pool==3.3.3，加入postgres optional group/uv.lock；只在本ROOT engine创建首个scoped .venv并使用uv缓存/现有Python3.12，不污染旧测试worktree虚拟环境、不升级无关依赖。

### 连接池与事务

默认min0/max4，同一进程共用，显式open/wait/close，连接/获取/语句/锁都有有限超时（建议5s/3s/5s/1s，可基于实际冷启明示调整）。每次借还池有清洁事务状态，异常回滚/坏连接丢弃；SET LOCAL在同一事务内，writer_version/search_path/scope不泄漏。全部业务SQLschema限定、参数绑定；未知字段/类型拒绝，BYTEA保留原bytes，金额保持TEXT，BIGINT不变float。

读有一致快照；写的expected_revision/ordinal/request_key用PG事务锁＋唯一约束，不能照搬BEGIN IMMEDIATE。可采用稳定scope/plan哈希的transaction advisory lock，不能session lock或依赖PgBouncer连接亲和。不要为FOR UPDATE盲授业务字段UPDATE。commit发送后断连/ACK丢失一律UNKNOWN，无自动重试/重扣；用已有业务request_key/hash/seq提供只读查证，查不到不伪称未提交。真实PG故障与可控ACK故障注入分开说明。

### 最小角色及权限边界

采用固定NOLOGIN读/追加写capability角色，实际LOGIN只授必要capability；owner仅bootstrap，正常池必须拒owner/admin/superuser/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION或neon_superuser/pg_read_all_data/pg_write_all_data等宽权限继承。DB credential仅可信后端使用，应用不暴露raw SQL接口。scope隔离在可信DAL层；未实现真实issuer/JWT/RLS，因此不能称DB凭据本身隔离所有租户或让客户直连。

最小矩阵：astarter_strategy_scopes只SELECT；strategy_versions/plan_versions/approval_references/episode_references/layer_references/recovery_checkpoints仅SELECT＋INSERT；pg1_metadata仅协议检查SELECT，若pg1_require_writer的FOR SHARE确需行锁权限，可精确UPDATE(singleton)（CHECK(singleton)使有效值只能TRUE）但不得修改版本/hash/manifest；accounts最多必要身份列SELECT，无金额或DML。不给订单/成交/结算/占款/风险原生表写权限，read-only capability无任何业务写。原PUBLIC默认能力如TEMP须如实列，不借此宣称零权限。

必须真实LOGIN非owner测试，不能SET ROLE owner或仅mock权限表。权限配置改变会影响PG1全目录pin；仅在新PG2child显式安装、为PG2运行握手提供精确权限/版本/真实schema核对，不去放宽PG1旧verifier，PG1原成果/SQL资源/默认profile保持。role/grants/protocol配置需有受控幂等及错版本拒绝；不从目标学习放行摘要。若新增运行metadata确有必要先说明，不另建业务账本。

### 测试与远端

先真实RED，再真实PG17本地LOGIN/pool/DAL验证：所有D1路径/正反例/轮换scope无泄漏、两个连接CAS/同键幂等、hash/版本/因果拒绝、read-only及native finance DML/DDL拒绝、池耗尽/异常回滚/连接回收/关机、协议错版、commit UNKNOWN保留及只读查证。旧SQLite定向兼容不得回退，打包后SQL资源可读。不得删断言、跳过失败或用固定对象mock冒充数据库。

作者仅本地新合成PGDATA，私有Unix socket/无TCP/精确owned清理，旧DB/秘密/Neon不读；公开PyPI/官方文档与依赖下载允许。Root审源码/脚本后只在bitter-waterfall-30256978现有项目中建PG2 child，来自PG1合成child br-hidden-wind-az92mxe7，保留PG1父分支。沿原0.25CU与有限quota，不新项目/买套餐/涨额度，完成暂停owned computes。真实Python direct＋Neon pooled路由分别验证，不把MCP SQL当driver证明；若安全凭据供给受阻如实留未验，禁止秘密进聊天/工具代码/普通日志或工程文件。无现用库迁移、外部数据API/真实长测、实盘、S03/F5/Task4。

## 文件地图

新增control/postgres/pool.py、strategy_repository.py、application.py、access_v1.sql及必要仅PG2codec/权限握手模块；修改__init__.py导出、engine pyproject.toml/uv.lock，最多原astarter/strategy_repository.py纯codec复用。新unit/integration/control/test_postgres_pg2_*及必要fixtures。旧PG1 schema_v1.sql/synthetic_migration.py、SQLite迁移001–008、Q01/D2经济合同、S03全部冻结。默认dependencies.py/app.py不改。实现需扩路径时由Codex按必要性判断。

作者最终固定clean候选和末次源码/日志/unique测试/真实PG/权限/清理证据；两路独立code/architecture审查，仍有同范围问题继续Hermes修。未完成交真实INCOMPLETE，不能自称全D3或产品启用。

## Finish1 同范围澄清

原候选及旧失败保留只读。history49 已有合法 scope，合成 smoke 必须复用原 ScopeAssignment
的完整字节与 binding，逐行验证原49行，不将账户换绑到另一个测试 tenant；本轮不新增 seed。
runtime runner 不导入 tests、不依赖 cwd，只读取本地预生成并固定 hash 的 canonical payload。

Root owner provisioning 与 app LOGIN 验证分离：固定 owner-setup-plan.json 由 Root Neon MCP
以 astarter_test_owner 执行；cloud_runner.py 只接受 reader/writer 的 direct/pooled 私有配置，
不接受 owner DSN。非秘密 authorization 由 Root 填写并外部 hash 固定，作者不自授权云目标。
默认运行零云 IO，真实执行限制90秒、连接/池/语句/锁有限；路径/权限/来源/身份/TLS拒绝不依赖 assert。
安装 wheel 的实际模块路径与字节、SQL资源、checkout及 runner/payload 全部核验后才允许连接。

普通独立命名 TEMP deferred-FK 仅用于提交期23503拒绝与连接回收验证；不伪造业务/系统/guard关系，
不扩大 app capability，不做已取消的提权反例。实际ACK后异常注入与backend终止证据继续分别标注。
本地通过不代表 Neon pin、TLS、direct/pooled、Root compute清理或最终两路复核通过。
