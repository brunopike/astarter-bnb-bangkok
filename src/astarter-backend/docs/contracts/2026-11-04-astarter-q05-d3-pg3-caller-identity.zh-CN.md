# PG3：可信应用caller、身份权限接线与耗时验证

## 目标和完成条件
基于已接受PG2 c5a72af，仅补策略参考持久化的真实HTTP/应用caller身份链：服务端验证opaque bearer凭据→服务端grant选择固定ScopeAssignment与权限→共享PG2 reader/writer池→请求独立仓储→canonical结果。通过真实本地PG、旧兼容、两路独立审查及同Neon隔离库的真实driver/ASGI caller与冷暖测量后接受。不是整个D2/默认流量切换或实盘放行。

## 最小身份模式
- 不接外部登录供应商，不自行实现JWT；使用stdlib SHA256/compare_digest验证后端配置的高熵opaque bearer凭据，配置只存digest。原始生产式测试token仅Root私密0600文件，作者本地用明确fake token。
- 一个token grant绑定一个subject/固定scope、固定reader或writer权限、有效时间/受众；不从body/query/X-Tenant/代理头/未经验证JWT声明取身份或选DSN。多个账户可用多个授权grant，无隐式管理员。
- 全部请求重新验证有效期和revocation；不缓存已认证principal。撤销阻止新准入，已准入请求可能完成，明确不声称数据库原子撤销/RLS。身份授权不是私人执行permit。
- 原始Authorization恰好一份，严格Bearer格式/长度；无效凭据401，已认证无操作权403；跨scope/不存在ID同一无泄露404（不反射ID/租户）。未认证/越权写必须在DB借用前拒绝。时钟用服务端，不接客户端now_ms。

## 应用与兼容
- 复用现有FastAPI create_app/LocalOriginMiddleware，显式opt-in参考接口和其唯一lifespan runtime；不开另一套工程/预览端口。默认旧HTTP/SQLite、public_data_only、historical保持原行为；不从env自动发现Neon或秘密。
- 参考专用only模式不得启动Control/SQLite scheduler或市场collector；不能通过mounted subapp遗漏lifespan。非测试默认不配身份必须fail closed，不存在testing绕过或默认fake授权。
- 共享的是有限PgRepositoryPool；每请求独立repo/不可变ScopeSource，禁止共享repo的可变_connection/current_scope。同步DB不要阻塞async event loop，取消/异常/启动一半失败必须收完池。
- 本轮HTTP闭合plan列表/读取/保存、私人approval reference保存、recovery保存/读取；其余episode/layer沿现有typed repo，不增加未调用的全套RPC框架。只准封闭路由/显式方法，无任意SQL/表名/getattr执行。
- 使用原Q01/D1严格canonical模型和原绑定/金额/预算单位；不能为了HTTP使用model_dump松化原始输入。请求体有大小/深度边界；错误固定且不记录body/令牌/DSN/validationinput/任意异常repr。
- 无公共approve-execute/start/交易功能；所有存储结果保留execution_authorized=false。

## 池和性能
沿用PG2最小权限、每事务verify_access/目录pin、SET LOCAL、scope锁、COMMIT UNKNOWN不重放。初次/reopen的serverless启动等待可显式配置10秒，生产默认不能悄悄改。先测量区分应用启动、物理连接/握手、身份校验、仓储读/写、HTTP总耗时/重开；不把PG2四route119秒当单次业务响应。
本轮目标：隔离Neon冷应用就绪<=30秒，暖plan-read目标<=2秒，拒绝身份的本机ASGI入口目标<=100毫秒且0DB。这些是本轮观测目标非既有SLA；超标必须诚实列出原因/待改，不伪称性能通过。N小用单次/中位数/最大值，不把小样本p95叫SLA。无时钟加速/模拟延迟冒充真实测量。
若实测发现PG2公共握手往返是瓶颈，只允许有因果证据的最小批量往返调整，保留每事务实际权限/源pin/隔离/COMMIT语义；不加TTL授权缓存/放宽time/source/role守卫。任何此类修改需RED/GREEN和PG2全受影响回归再两路审查。

## 工程与运行边界
唯一ROOT原worktree；新增identity/caller/参考router模块与定向tests，现有app.py/dependencies.py仅显式接线（更小者优先）；PG2application可最小复用扩展，不改D1域/001–008/PG1固定资源/D2财务/S03/前端。stdlib/现有依赖，禁安装升级。root用户授权的PG3文档包含在本地commit，保留历史，不amend/reset/push。
作者只在新E建自有PG17合成库/Unix socket，原PG1/2证据与现用库不碰。Root才用既有私密受限配置跑Neon，作者不读秘密/真实库/网络。云项目bitter-waterfall-30256978、既有PG2 branch br-wandering-feather-azthdxyw/endpoint ep-divine-lake-azxddtms，现有scope与49原记录+PG2一条request保留，无owner/权限扩张/现用迁移。云预算沿已有project quota；本轮全部真实阶段合计<=360秒、<=30个ASGI请求、<=16物理连接、最多2次明确cold cycle，失败不自动重启/重放。
Root必须外层owned process硬截止、每次cold先明确停止既有owned compute并读idle，然后一次启动首次DB请求计时。ASGI进程内不等于真实TCP/浏览器，主动挂起也不等于自然休眠样本。结束停owned compute，原其他computes/服务不动；quota不提高、不买额度。

## 验证与接受
RED对照原caller无认证/接线；成功身份+权限、伪造/重复/过期/撤销/错误受众、同pool两个scope并发/排队、reader写拒、跨ID同404、恶意输入与错误脱敏、timeout/cancel/启动失败关闭、UNKNOWN不重放、默认零云IO、实际wheel源绑定和optional-base兼容。真实本地PG正负验证，不靠mock验权限。主体定向兼容/mypy strict/Ruff/wheel打包由Hermes完成；固定候选/日志/hash后两路独立审查，Root实际有限Neon ASGI/cold-warm再最后审查。未测项目诚实列出，S03始终PAUSED。

## 2026-11-04：经基线重现后的必要测试维护租约
PG3 finish1完整859项，833pass/26fail；对git c5a72af新导出的同一26nodeid/message实证相同。Root允许仅tests/sqlite_corruption.py的current-writer合成损坏夹具对齐现有schema8真实注册协议，及tests/integration/api/test_commands.py两处健康/响应schema预期6→已冻结8。生产database.py/migrations/guard、旧二进制拒写测试和所有完整性拒绝断言保持。不得将基线失败xfailed/删减/降低断言；维护后实际验证这些原负例已到达业务完整性拒绝分支。此为测试夹具/既定合同对齐，非现用DB迁移。
