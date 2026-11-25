# Q05-D3 / PG1：真实本地 PostgreSQL 合成迁移候选

基线：`7268e733e4f394d4e26519aac742cf529490a64b`。

**finish1 在新建 owned PostgreSQL17.11 上实际执行 schema、迁移、反例及事务测试。
这是 PG1 SQL/合成迁移限定候选，不是完整 D3，不是 Python AstarterControl 已切 Postgres。
作者完成与 Root 接受分开；云端仅由 Root 审后在新空隔离项目/分支执行。**

## 1. 权威与冻结

SQLite 仍是唯一交易写权威；无双写、启动切换或 PG 连接配置。001–008、database.py、
Control/runtime、Q01/D1/D2、S03、私人批准、前端全未修改。
`execution_authorized=false`、Q01_PRODUCT 阻断保留。旧保护/退出不依赖研究 Credits。
不涉及 F5/Task4、Neon Auth、钱包、充值、模型、Kronos/OpenRig、18Agent 调度。

## 2. 字段映射

SQL resource 保留全部37个 source table，另有1个迁移 metadata 表；不是只迁移准入三表。
由源码001–008在全新内存 SQLite 构建最终 schema 后，一次性生成静态 SQL；生成器属于
TASK 证据，不是 production runtime 方言层。全部源列、CHECK、PK、UNIQUE、索引与FK
都有对应；90个非writer业务 trigger 转为PL/pgSQL。finish1原2757行资源在PG17.11解析/建库通过，
reviewfix1仅补函数命名空间卫生；关键trigger/FK/唯一/类型/事务路径实际运行。不是全部业务状态穷举证明。

| SQLite | PG候选 | 注意事项 |
|---|---|---|
| INTEGER | BIGINT | 保留有符号64位、整数时间、epoch/fence/序号、0/1；不擅改boolean |
| TEXT | TEXT COLLATE C | 金额原字符串、币种/单位、时间字符串、hash/身份原值；不转float或自动定标 |
| BLOB | BYTEA | canonical原字节，不转JSONB，不重新序列化JSON负载 |
| NULL / 空TEXT / 空BLOB | 三者独立 | typed hash区分；UTF-8严格编码；TEXT NUL明确拒绝 |
| rowid表 | 新列legacy_rowid BIGINT NOT NULL UNIQUE | 保存所有隐式rowid，包括稀疏/负数及INTEGER PK alias；不可变 |
| WITHOUT ROWID | 原PK排序 | D1/D2保持复合身份，不制造隐式行号 |

按表/字段映射与源trigger→PG函数对应见TASK旧 `q05-d3-pg1-20261104-1b054fb108/`
的 `mapping.json`、`trigger-map.json`；字段映射和业务谓词保持，函数解析配置变更见第8节。
源Schema哈希与PG SQL资源哈希在manifest/verification；不把owner有DDL能力视作安全漏洞已被消除。

## 3. 离线包实际实现

`control.postgres.synthetic_migration` 不连接Postgres，不读取URL/凭据，不发现数据库。
只接受调用者明确给出的**关闭、脱离运行的合成SQLite**。拒绝symlink、WAL/SHM/journal，
使用`mode=ro&immutable=1`+显式只读事务；这是关闭fixture合同，不是活动WAL备份方案。
前后文件SHA对比，不重写源。schema8 fingerprint、FK/integrity校验后处理全部表。
总行数最多100000，源/typed payload上限64MiB；超过明确拒绝，不静默截断。

typed行编码为每cell `tag + UTF-8字节长度 + ':' + 原payload`：n空值、i整数十进制、
t文本UTF-8、b字节原值。每行SHA256，稳定排序后的行hash再构成表hash；manifest包含全部列
类型、排序和逐行hash。source文件物理hash另存，不进入逻辑manifest，允许逻辑相同的合成快照。

生成的psql包设计：BEGIN→固定advisory事务锁→空目标校验→新schema/table/index→完整数据→
验证FK并安装guards→metadata→每表逐行typed hash比较→COMMIT。历史terminal等最终状态先导入，
再安装初始INSERT生命周期guard，全部在一个新目标事务内；不会向既有目标关闭guard。
同manifest重跑锁住各表只读核对；异manifest/版本/数据差异拒绝。SQL没有DROP目标/覆盖既有表路径。

重跑在同一事务、metadata及全部源表SHARE锁内校验metadata、真实catalog、逐行typed hash。
catalog基准从**另一个新空PG17目标执行原资源**后独立捕获并固化在生成器，不信目标自报摘要。
包含column/type/null/default/collation、CHECK/PK/UNIQUE/FK及validated/deferred属性、索引定义/状态、
trigger定义/启用状态（含内部FK trigger）、实际函数完整定义、关系属性、namespace依赖对象清单、
rule/policy、扩展/event trigger及非owner表/函数/schema grant；reviewfix1补完整显式列ACL。
多余schema/非table对象也拒绝。
资源SHA pin防止仅改schema却继续使用旧catalog期望；PG major或平台baseline不同必须另行审查，
不能静默放宽或删除平台对象。16项先实跑“应拒绝却成功”RED，修后GREEN；另补FK/约束修改等负例。
拒绝后核目标受损catalog和全部typed数据仍不变，不删除对象、不关闭guard、不自动修旧schema。

owner仍可信且有DDL权。advisory事务锁(170501,1)是所有受控owner DDL须遵守的排他协议；
SHARE锁阻止普通表DML/冲突DDL，函数DDL仍依赖可信owner遵守该协议。本包不是防恶意DBA认证。
同manifest重跑没有数据/DDL写；实际txid_current_if_assigned仍NULL。应用后续合法变更数据/授权
会使该快照验证拒绝，这是迁移快照校验，不是运行中数据库自动修复或通用upsert。

## 4. 已实测的角色与事务边界

- owner只负责迁移/DDL；schema/table/function撤销PUBLIC默认权限。
- 非owner app不授raw table权限；集成负例用实际LOGIN角色，不用SET ROLE冒充连接。
- 不宣称DB级租户RLS隔离；SET tenant不是认证。后续受信backend的scope检查、D1/D2复合FK
  是应用信任边界；真实issuer/auth/签发不在本包新造。
- SQLite STRICT/PRAGMA/UDF writer guard不可直接带入PG。候选为schema/source/writer三版本metadata，
  每表statement trigger（包括零行DML），事务内metadata FOR SHARE及SET LOCAL writer=1。
  GUC只是兼容性协议，不是权限；trusted owner能绕DDL边界，app禁止raw访问。
- BEGIN IMMEDIATE改为PG显式事务+账户FOR UPDATE+epoch/fence CAS；锁内重读准入/占用/锁，
  锁外native capture/网络/模型。SQL模式验证不意味着Python控制器已实现该事务路径。
- 实测两个独立非owner LOGIN backend、不同pg_backend_pid、行锁实际Lock等待、epoch/fence CAS，
  分现金/风险、重叠及A先/B先三种顺序；败者旧CAS零行且刷新后容量不足，旧UNKNOWN占用不释放。
  使用原Control源码产生的候选receipt和Q03精确量/费/压力值；现金442.92569056与风险10为明确的
  更保守合成SQL测试上限，非另造native余额。仅插入原intent/order/link并测锁/CAS/聚合原语，
  没有复制Python的完整准入、freshness、owner授权、审计与调度算法。
- 非owner app实际raw读/写/TRUNCATE返回42501；trusted backend异scope复合FK返回23503。
  后者是明确授信后端，不是客户角色；SET自填tenant仍能读受授信范围，负例明确证明没有RLS隔离。
  fixture为metadata FOR SHARE授UPDATE(singleton)，以及受测表权限；不是生产least-privilege/auth方案。
- 新目标导入完成后真实deferred-FK COMMIT失败、terminate backend中断均全DDL/数据回滚，重开
  确认schema不存在，同源可重试；既有目标事务失败后全typed数据仍一致。没有猜PID或killport。
- native round_trip/partial_stop各独立源和目标，真实fill、费用、settlement、利润锁/亏损原值迁移；
  仅在这次新合成运行已提交时backup partial快照，不复制现用库。旧Control helper生成合法
  COMPLETED/审计/outbox/seal历史。所有37表列入manifest，仍空的表如实列在证据，不声称全业务覆盖。
- append-only UPDATE/DELETE及冲突更新拒绝；经济事实ON CONFLICT DO NOTHING保持原bytes，
  但DO NOTHING不是“同key同payload”的应用幂等认证，完整业务payload检查仍由冻结SQLite承担。

## 5. caller / config / export地图与后续DAL缺口

| 当前入口 | 冻结事实 / 后续必须适配 |
|---|---|
| database.open_control_database → registry.ControlStore.open | 仍创建sqlite3.Connection，WAL/FULL、精确schema、BEGIN IMMEDIATE |
| dependencies.build_default_dependencies:447 | 配置仍是runtime_root/control.sqlite；本包未调用该组合根、未打开该路径 |
| astarter/service.py:937、1229 | ORDER BY rowid；后续PG必须显式ORDER BY legacy_rowid，不依赖物理行序 |
| strategy_repository / transaction_service | sqlite3.Row、?参数、Python Q01/hash/causal校验与原scope/准入；保持原样 |
| historical_configuration/preflight/terminal与registry | 同一共享SQLite控制链；不能因schema存在宣称这些caller已ported |
| synthetic_migration.main | 离线CLI写manifest.json/bundle.sql/verify.sql/neon-smoke-plan.json，不执行SQL |
| package/export | schema通过importlib.resources读取；源码模式已跑，wheel打包资源尚未实测 |

ROOT内 `sourceSchemas`、`sourceSchema`、`source_schemas` 等精确/变体查询未命中，未捏造该文件。
若派工指的是另一具体源合同入口，Root应提供精确路径继续核；未因未命中宣称工程不存在此概念。

后续明确切片：安装/锁定真实Python driver与pool（需独立授权）；NUMERIC/BIGINT/bytea返回类型；
参数/Row/异常映射；事务上下文与COMMIT未知处理；版本/owner/fence/scope/admission运行接线；
真实issuer及失效监听；所有caller兼容；唯一写权威切换/回退。禁止做大规模sqlite模拟包装或假driver。

## 6. 本地与Neon边界

预检实查psql/pg_config为Homebrew PostgreSQL17.11，指定解释器Python3.12.4。没有安装依赖。
旧轮因长socket路径未启动PG的INCOMPLETE证据完整保留。本轮使用Root已建立且批准的
`/private/tmp/astpg1-41f2bec52a4d`→TASK本轮0700 socket目录；新PGDATA仍在TASK内。
独立harness核alias lstat owner/inode/target/mode、PGDATA inode、pg_control系统ID、PID文件和
cluster_name nonce；listen_addresses=''，无TCP。finally精确stop后仅unlink该授权alias，
PGDATA、失败、日志保留。实际启动/停止/PID/fingerprint以cluster-owner/final证据为准。

`neon-smoke-plan.json`绑定source/resource/manifest/catalog SHA；transaction_statements为真正
独立的有序SQL列表，PL/pgSQL dollar body完整。生成器只分割固定资源的有限语法，不引入driver。
schema/import/post-load三组是审阅视图，Root必须执行完整transaction_statements于**同一交易**；
无psql元命令、凭据、扩展安装或顶层DROP/TRUNCATE/DELETE。CREATE TRIGGER里的DELETE/TRUNCATE
事件是保留保护定义，不是破坏操作。每条语句已在本地独立往返执行，再由psql包重跑核同catalog/typed数据。
reopen_transaction_statements用于新连接核对；平台多出的托管对象必须先停下单独判断，禁止删除。

Root只可在审完后用**新的空隔离Neon项目/分支**复用合成脚本；禁止任何现用DB复制。
作者没有API/HTTP/DNS、云连接串或凭据操作。云端必须独立验证：

- direct连接进行reviewed事务DDL/导入/重新打开核对；实际角色权限、版本和扩展可用性；
- PgBouncer transaction pooling不可依赖session SET、临时表、跨事务会话锁或连接亲和；
- SET LOCAL必须在同一事务设置并验证复用后不泄漏；显式metadata行锁/账户锁也须同事务；
- 池下PREPARE、失败事务清理、COMMIT断线未知、连接回收与重试幂等须独立实测；
- 本地通过不替代Neon实际app/direct/pool验证；作者没有连接Neon。

## 7. 状态与证据

TASK本轮：`q05-d3-pg1-20261104-finish1-41f2bec52a4d/`。旧目录全部只读，旧23项仅收集不计通过。
本轮catalog真实RED及全部准备失败保留；末次源改后重新跑PG与原382离线范围（含必要扩展）、
strict mypy/Ruff，再固定clean commit。准确去重数、命令/exitcodes、日志/source hash、
交易调度与全部不足在本轮verification/handoff。作者候选不等于Root独立接受。

## 8. reviewfix1：仅R1/R2窄修复，仍待Root两路复核

继承clean `4919c4ff573237fc35d30ecee01b5435641b8a80`。前轮447个不同测试（60真实PG、
387离线）及Codex独立核验是历史证据，不抵销code REQUEST CHANGES / architecture WATCH。
本轮证据只在TASK `q05-d3-pg1-20261104-reviewfix1-f13a0a2408aa/`，旧包/日志/失败只读。

- R1：`pg_attribute.attacl`逐项展开；包含关系、列序号/列名、grantor/grantee、权限种类与
  grant option。主体以带标签的owner/public/具名role表示，消除OID和owner名称差异，不把
  同名普通角色混作owner/PUBLIC；所有显式列ACL（包括owner）保留。NULL/空ACL均无显式授权项，
  最终仍以C排序规范化，不依赖ACL数组授权顺序。原非owner关系/函数/schema规则不放宽。
- 初始原生产字节上，SELECT列、UPDATE列、可转授SELECT、PUBLIC、INSERT、REFERENCES、owner
  显式列授权后重跑均exit0，是实际RED；原未授权合法库通过。无schema USAGE时app仍42501，
  **不声称已证明泄露**。回归要求只拒绝，不REVOKE/修复；前后原ACL和全部typed数据保持。
- R2：全部93个trigger函数显式`search_path=pg_catalog,pg1_control,pg_temp`，临时命名空间末位；
  writer的关键metadata锁定为`pg1_control.pg1_metadata`，业务关系在固定持久schema优先路径内解析。
  不改变SECURITY INVOKER和业务谓词。静态源配置及实际pg_proc配置/完整body逐一对照；
  正常writer更新/回滚、原重复引用与版本错误等普通正确性回归继续保留。
- **没有编写、执行或重试权限绕过、提权或临时表伪造反例**。R2仅静态防御性修正与普通数据库
  正确性验证；不能把未执行反例写成行为安全证明。
- 改SQL后在本轮新cluster的两个独立pristine数据库仅执行resource，metadata保持空，重新捕获
  catalog/empty oracle；93个真实定义与资源body及配置吻合。非function catalog与前轮相同，
  empty pin未变；只据实际捕获更新resource/catalog pins，不信迁移目标自报hash。
- 三profile重新导出source/typed/manifest和structured计划，保留history/partial费用、利润锁、
  UNKNOWN及未完成义务；逐行typed核验不是count核验。history计划独立语句仍须同一交易执行。
  Neon平台baseline如有差异仍停下由Root另审，不盲放宽。
- 本轮仅Root授权alias `/private/tmp/astpg1-f13a0a2408aa`，PGDATA只在本轮E/pgdata，
  PG17.11、listen_addresses空；精确PID/UID/fullcmd/path/nonce/inode核对后finally停自有cluster，
  只删除确证alias，保留PGDATA和所有fixture/log。末次工程bytes后的实际测试数、命令、hash、
  清理与35保护输入核验，以本轮verification/handoff为准。

范围不扩为DAL/产品接线；SQLite唯一写权威、execution_authorized=false、Q01_PRODUCT阻断。
本地作者完成不等于fullD3、两路审查通过、merge或云批准。

## 9. neonprofile1：两个固定显式目标基线，非平台自动适配

基线固定为clean `14c1b46f553fd41dc712635c3a34d4327dbfdb2e`，前轮两路delta结论为
代码APPROVE/架构CLEAR。新证据只在TASK `q05-d3-pg1-20261104-neonprofile1-bdc63862910d/`。
Root落盘 `q05-d3-20261104-neon-evidence.json` 是平台事实唯一来源；作者不访问Neon/网络/秘密。
旧包对准确合成平台基线真实报 `PG1_TARGET_NOT_EMPTY`，且未写target；这是严格基线的
兼容拒绝，不是SQL错误、安全漏洞或云端导入失败。Root此前仅只读metadata，未执行import。

- `TargetProfile`仅有`LOCAL_PG17`（所有入口默认）和`NEON_PG17_V1`。Python入口只接受
  固定枚举，CLI以`--target-profile`固定choices映射；unknown/auto/hash输入在源处理前拒绝。
  new/replay/catalog/typed verify/psql/structured export贯穿同一选择。typed helper仍只核数据，
  完整verify导出及replay另外强制catalog校验，不把单独typed helper当目标接受。
- 不探测平台、不从目标或metadata学习hash、不忽略/删除对象、不自动修复；同source manifest
  不代表同target基线，错误profile仍由实际catalog拒绝。typed source manifest和metadata结构不变。
- catalog新增全部`pg_default_acl`对象头及每项grant。头独立于`aclexplode`，即使空ACL
  仍存在；namespace=0显式`[global]`，schema为`[schema,name]`，不漏全局默认。
  creator/objtype/grantor/grantee/privilege/grantable全保留；default ACL角色用具名身份，
  不把`cloud_admin`或`neon_superuser`折叠成普通owner。原namespace、对象与权限检查不放宽。
- 合成平台只有public及plpgsql，恰好2个defaultACL对象、9项可转授权限：creator/grantor为
  cloud_admin，schema public，grantee neon_superuser；S为SELECT/UPDATE/USAGE，r为
  DELETE/INSERT/MAINTAIN/SELECT/TRUNCATE/UPDATE。没有REFERENCES/TRIGGER，不使用ALL。
  这些默认仅影响指定creator/schema未来对象，不直接授权astarter_test_owner新建的pg1_control表。
  平台角色仍为trusted admin；本地同名NOLOGIN合成角色仅复现catalog，不模拟真实admin权限或RLS。
- 两profile各自两个新pristine库独立capture empty及resource-only full；metadata始终空。
  LOCAL旧/新oracle结果逐字节相等，empty/full pins均不变。Neon增加两个头+九项grant，
  原来两个namespace依赖对象仍保留。固定pins如下，不从迁移目标自报学习：

| profile | empty SHA256 | full SHA256 |
|---|---|---|
| LOCAL_PG17 | `9161b39451561c9fa53fa31ca8ae96ecd87aee0615888409fe6d03781fbd1edd` | `9b41f9b962765e81ec3c82098085298b1b59cb4daebf7d3a1058c72536a69b00` |
| NEON_PG17_V1 | `8d1aa29bb227946de88601bd5545a1d463830d85fe6e04b14c133d37697f1d94` | `56bfbb75089116a5e8aadbd88d5d9c407ee577e1eb6bdc415317dd70147160f2` |

SQL resource、93个guard配置及业务谓词不改；`__init__.py`不改。回归包含默认入口旧458范围、
两profile import/replay、错profile、缺项/额外REFERENCES/TRIGGER/creator/grantee/schema/global/
grantable/空对象/额外对象/columnACL等普通catalog正确性负例；拒绝后数据与ACL保持。
没有编写、执行或重试先前取消的权限绕过、临时表伪造或提权反例。最终实际测试身份与分类、
strict mypy/Ruff、失败日志、输入hash和owned cleanup以本轮verification/handoff为准。

重导history structured smoke plan显式带profile与两个pins，所有schema/import/post-load/验证
仍在单交易，新连接独立reopen核验。全37表typed覆盖不等于全部业务有数据；空表和未覆盖项
明确列于delivery证据。Root后续仅使用已有专属sandbox的新child，不另建project或提高额度。
作者本地合成通过不称cloudpass；须两路独立窄审和Root实际cloud readback后再作PG1接受决定。
SQLite唯一写权威、execution_authorized=false、Q01_PRODUCT BLOCK；不是fullD3/DAL/pool/auth批准。
