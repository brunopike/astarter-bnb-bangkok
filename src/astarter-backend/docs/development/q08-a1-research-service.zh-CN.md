# Q08-A1 第四步：显式 stub 研究服务

只在可信离线组合入口构建 `ResearchService(repository, executor, clock, drafts)`。repository 永久绑定服务端 Principal，不能从正文指定身份、payer、SQL、profile 或 cwd。`drafts` 是预先注册的合成 ABC，对应冻结 manifest hash；不是生产模型 renderer。默认 app 不注册路由、worker、模型、通知或交易 adapter。

## 有限入口

- `submit(trigger)`：用现有后端固定 Principal/policy 编译并幂等入库。
- `run_once(job_id, worker)`：恢复已到期责任，然后最多领取和执行一个角色；只接受原两个 worker ID。不设守护进程或模型轮询。调度者显式调用下一次，原每 job2/全局4和正常派发6/8/12上限不变。
- `read(job_id)`：沿现有 scope/D1 权限读取；旧 bundle 保留原版本与时刻，当前过期时返回 WAIT_DATA，不能重播成当前 READY。
- `attach_public(job_id, producer, artifact_id)`：先持久关联再显式激活公共依赖。两事务之间中断只有无执行意义的关联；重放可补激活。PUBLIC 产物、来源 manifest/RoleReport 和原时间保持原样，不生成私人 A01/A02 报告或复制 producer 账单。
- `wait_for_public(job_id, expected_version, source)`：未开始的私人研究显式挂起，问题绑定原公共 job/hash；来源未完成时0模型轮询。原公共A01/A02均已合法关联、not_before已到且回答/CAS有效，才能续办。不能用其他公共 job 静默替换来源。
- `answer(question_id, nonce, choice, expected_version)`：仅 RESUME/CANCEL，绑定当前私人 scope、问题、nonce、版本、not_before 与最早截止。重复原答复幂等；正文 ANSWER 评论没有续办权。RESUME 只重新检查被冻结的研究条件，不补数据、不增加预算、不改 payer，也不生成批准。
- `cancel(job_id, expected_version)` / `recover(job_id, worker)`：沿原 owner/fence/receipt 处理；取消和回答事实同事务。只释放已证未发送预留；sent UNKNOWN 保留，可信 invoice/旧结果分别恢复，0自动补试。
- `review(job_id, expected_version, approval_id)`：只读同 scope/plan 的已有 D1 私人引用；职责/来源/有效期/issuer继续走冻结合同。没有输入 JSON 批准或真实执行权限。

## 持久事实与 BTC 样例

仍用原7表及原访问 profile，没有新表、pin、GRANT、迁移或第二账本。QUESTION/ANSWER/DEADLINE、PUBLIC_DEPENDENCY、RESEARCH_BUNDLE 分别是受校验事件；不可变内容/hash与 job CAS 同事务。原预算、费用、RoleReport、artifact、NOTICE_INTENT 语义不变。NOTICE 只表示意图，投递状态不伪称 SENT。

预算不足且尚无receipt/permit的同一attempt可以在认证续办后重新领取为CLAIMED；不是重发已有许可。部分审阅或其他角色完成后，仍未回答的问题保留等待语义，并刷新其有效CAS，不放宽not_before或原截止。来源过期/撤销落持久WAIT/DEADLINE，不能保留RUNNABLE假象。

公共 job 命中缓存时，通过不可变PUBLISHED指针校验原artifact行；consumer FK仍连接原producer。来源job与原producer都必须当前可用，原时间、PUBLIC descriptor和唯一费用不复制或重标。

用于私人依赖时，代理和原producer的deadline、root quote、对应role quote、model policy、原证据/产物期限都取严格边界；主体与clock epoch必须一致。缓存代理的新报价或期限不能延长原producer的可用边界。再次预算不足会在同事务生成新问题，旧RESUME不能变成持续预留探测；更新问题不提前not_before或延长旧截止。

首次WAIT_BUDGET即为持久领取屏障：即使问题尚未创建就崩溃，恢复也不能再次领取；其他已在途角色的结果不会抹掉该屏障。只有对应BUDGET问题的认证回答才能重新提案。等待截止复用与产物准入相同的快照边界，包括来源角色报价、模型有效期和数据最大年龄；已经完成的缓存来源也取原producer的最早边界。

任务1纯调度增加可选 `public_facts` sidecar，默认路径保持原合同。只允许已验证、同完整 BTC instrument/原证据、角色语义/模型/profile/effort/credential/policy/clock 的 PUBLIC A01/A02 满足私人根依赖。当前来源/TTL另验。私人节点仍生成 PRIVATE 请求，A08/A09不见彼此草稿，A10获得双方与A12及原证据。

本地两个租户/账户的样例：一个平台公共 job 执行2次 stub；两私人 job 各复用这2份公共事实，再各执行 A08/A09/A12/A10/A15/A13 六次。合计14次 stub，不是单 job14派发。每次10 SIM atoms 的受控 invoice 独立落账；五层预算行不是五笔费用。这里没有真实价格、盈利、节省比例或模型质量结论。

完整研究 bundle 含已注册 A/B/C 规则引用；缺九职责仍 WAIT_REVIEW。独立合成私人引用齐全也只产生 `reference_only=true / execution_authorized=false`。缺或无效 ABC 不升级为 READY；合法 NO_TRADE 与技术失败分域。

## 边界

仅新本地 PG17 合成库、Unix socket。冻结 SQL/ACL/profile、旧 DAL/身份/目录检查不改；Neon Q08、现用数据库、真实模型、前端、生产部署和 S03 均未接入。本包不保证外部 exactly-once、生产吞吐/延迟、自动服务重启或真实长时间连续性。

恢复需要重建相同可信配置；已发布 bundle/等待/费用均在 DAL，未发布的合成 renderer 草案仍需同 manifest 注册项。完整 Q08 Task5 验收另行归口，不能用本步通过关闭整个产品。
