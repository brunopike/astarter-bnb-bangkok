# Q08-A1 任务3：本地持久 ResearchBackend

本切片只补研究端口，复用 Q08 七张表、显式 Q08 LOCAL_PG17 profile、原 DAL/pool 和 `owned_thread`。不注册服务、worker loop、模型/通知/交易 adapter，不迁移运行库。Neon Q08 未验，仍拒绝连接。

## 入口与信任边界

`PostgresResearchRepository(pool, principal, SyntheticAuthority(...))` 永久绑定一位由后端选出的 `Principal`。用户 JSON 不是身份来源；应用数据库登录是可信后端能力，不是 RLS 或终端用户直连权限。私人 scope 必须与现有 D1 分配全等；writer 和 reader 继续使用原访问校验。

- `submit_job(manifest)`：重编译并核对已冻结合同；同 job/logical request 只接受原字节。
- `read_job(job_id)`：只读历史 manifest、角色状态、报告和每笔逻辑成本；`current_data` 不代表已批准或可执行。
- `claim_ready(job_id, worker, expected_version)`：注册 worker、job CAS、每任务最多2个和全局最多4个未完成领取；每 role 一个 attempt，无自动补试。整个原始逻辑请求只对应一个 job。
- `backend(claim)`：实现原 `ResearchBackend` 全部异步方法。请求、owner/epoch/claim、原 grant、source rights、当前 D1 plan 和时间在派发前再次核对。
- `heartbeat(claim)`：只延长仍合法且未过期的 owner lease（30秒），不增加 epoch；没有定时器或后台 worker。
- `cancel_job(job_id, expected_version)`：只释放已证未发送的预留；已发送未知责任不退款。
- `recover_job(job_id, worker)`：未发送且仍有效可交新 epoch；过期未发预留可释放；已发失联进入 UNKNOWN，不重发。已确认、有效且仍有使用权的持久结果可完成发布，不再执行模型。
- `reconcile_attempt(job_id, attempt_id, observation)`：只按后端预登记的合成 invoice 补结局，不生成 permit、不在该操作里发布结果。
- `append_event(job_id, event)`：只允许 QUESTION/ANSWER/NOTICE 文本；事件内容不执行命令，也不充当批准、预算或恢复控制。

`SyntheticAuthority` 是启动时可信合成政策/worker/invoice 配置，不接用户输入或动态模型断言。配置版本变化须重新核对 frozen manifest；本切片不提供真实凭据吊销服务。D1 plan 更新与研究派发共用原 scope advisory lock。异步取消会等所属线程的事务结束再返回，不能把遗失回执当未提交。

所有必需锁取得后采样数据库时间，最后派发准入再次检查 owner/grant/截止。仍沿用原池的1秒锁等待限制；拥堵时可能固定拒绝，调用方不得把拒绝当已领取，也没有后台自动重试。

## 共享与权限

使用任务1完整 `reuse_key`，包含 subject、角色语义/模型/profile/effort、证据、scope、payer、key owner 和 credential revision。只共享全等公共研究或同一私人域。只要 producer 仍在发出/对账，或已结算但尚未发布，就不能为相同键另起一次调用。

缓存命中保存 `research_consumers` 引用和 CACHE 报告；不带 producer 的账单、不重复计费、不改原 source/created/use_until。原 gate 的读/交付授权端口也走现有完整 artifact 校验。

`attach_public_reference(job_id, producer_ref, artifact_id)` 只能连接真实 PUBLIC 事实、相同完整 instrument 和原始证据合同。返回的 artifact 仍是 PUBLIC，不改 PRIVATE descriptor，不伪造私人 RoleReport，也不使私人 DAG 完成。私人 DAG 的组合由任务4服务处理。私人/BYOK 结果不能借此公开。

## 模拟预算、发布与恢复

五层保护为 OWNER → ROOT → TASK → DAY → PLATFORM；在短事务、固定锁序下检查并更新所有 cap。一笔 reservation 对应五个保护行，读取成本按 reservation 去重。单位只为 `SIM_MODEL_CREDIT_V1 / scale=6`，不代表 USD、供应商 points、用户积分或资金。

预算命名使用独立固定模拟预算修订，切模型/credential 不会自动重置 owner/day/platform cap。DAY 使用数据库 UTC 日，历史预留/结局留在原账期。UNKNOWN 保持占额，且阻断同 owner 的新付费预留；仍可读合法缓存。cap 不动态调大，已知费用也不超 quote 强行入账。

`start_once` 只有一次数据库 CAS 的胜者拿到 permit，持久化只保留其 hash/状态。提交确认丢失后仅检查原 attempt；不能取回或重签 permit。这是一次派发准入，不是外部 exactly-once 承诺。

原始 permit 截止时间保存在同事务事件中；恢复的输出也必须满足该时间界限，并与可信 invoice 的实际 provider 相同。畸形持久记录返回固定拒绝原因，不回显其内容。

permit 同时受冻结角色的 max_latency_ms 限制。输出完成时间不晚于合法 artifact 创建时间，后者仍须不晚于当前可信时间且不得延长 TTL；不要求结算事务耗时为0。UNKNOWN 的已存非空模型结果不可被不同输出/hash重放替换，可信迟到账单可单独补齐成本，未知结果到达也可保留但仍不发布为已交付。

已确认的上游模拟成本独立持久化；结果不合法、过期或发布失败仍可能有成本。合法发布把 artifact、RoleReport、SIM 交付引用和 NOTICE_INTENT 放在同一事务。失败无半份发布，重放无重复产物/扣计；NOTICE_INTENT 不等于送达。成功角色不得覆盖同 job 其他 UNKNOWN。

无效已结算结果的恢复写入 WAIT 审阅事实；同 job 尚有未知责任时，顶层状态继续为 UNKNOWN，已知成本与待审阅原因都保留。

## 验证边界

新测试仅通过受控 Unix socket 连接本轮全新合成 PG17。源码/SQL/profile/pin 没有因测试现场学习或放宽，原金融表没有研究写权。临时测试库在关闭本轮连接后按名称、UID、inode 和实际 data_directory 核验后清理；命令、失败、收据与 source fixture 保留。

覆盖领取/共享竞争、原子额度、owner 过期/接管、迟到 invoice、取消、四阶段 COMMIT ACK 丢失、重复/冲突 token、未知恢复、发布回滚、source/plan/model/profile/credential 版本失配和原 gate 兼容。具体候选、命令与独立审查以项目交付记录为准。

限制：全局短事务 mutex 是首版有限并发方案，未做吞吐/云端/1000用户/真实连续长测或实体手机验证。真实模型、商业账本、服务/worker、等待续办、BTC完整流程、前端与 S03 仍未接入。
