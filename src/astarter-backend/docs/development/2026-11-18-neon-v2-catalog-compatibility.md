# Neon v2 精确目录兼容 / Exact catalog compatibility

任务：STA-90，挂在 STA-74；完整仓库基线 `23405d673431d280646fc7b5778ee2612a646fc2`。本轮只回收已准备的兼容机制到当前 Core 和 PRIVATE 分发，不部署、不连接云端、不改数据库内容。

## 问题与边界

原 schema-v2 的完整指纹为 `d5242c0c184e888c7b8e23c305036e3c3c679af814ffaca430fd04b6f7fbcd19`。此前独立只读诊断保留了原 200 组目录，并发现平台在 `public` 下多出四组、13 行默认授权及对象记录。应用角色并未获得 `cloud_admin`／`neon_superuser` 成员身份。

本地新建 PG17 重建的九项转授为 `cloud_admin → neon_superuser WITH GRANT OPTION`：表 DELETE、INSERT、MAINTAIN、SELECT、TRUNCATE、UPDATE 六项，序列 SELECT、UPDATE、USAGE 三项。整份目录指纹为 `6fd8ee3d17863eeeb467afcf15296973178f1da8352d5e9766210716d336f95c`。

这是观测目录的精确本地重建。官方默认授权中的 `ALL` 是上界，不能证明此九项的形成时间、操作者或平台版本。因此保留来源归因 WATCH；不称它为新的独立官方 oracle。

## 最小改动

- `private_ui_migration.ui_catalog_matches` 在先验资源校验后，保留原 pin，只为 Neon v2 接受上面一份额外完整指纹。升级的幂等检查和 postcondition 共用它。
- `verify_private_access` 先保留危险权限短路，再仅在 schema-v2 使用该匹配；v1/v3 仍走原 profile pin，最后仍校验 metadata。
- 两处生产文件由 Core 显式同步至 PRIVATE；49 个导出来源保持同字节。PUBLIC 来源、SQL、角色、连接池、Origin／audience、预算及事务逻辑不改。

| 条件 | 结果 |
| --- | --- |
| 原 Neon v2 或 LOCAL v2 目录 | 保留通过 |
| 额外精确目录 + Neon v2 | 通过目录比较，仍须通过全部应用权限和 metadata 检查 |
| 相同额外目录 + LOCAL／v1 | 拒绝 |
| 未验证 Neon v3 | 拒绝；`NEON_DRAFT_PIN=None` |
| PG17 `ALL` 十一项、转授变化、额外 PUBLIC 权限、业务列变化 | 完整指纹不同，拒绝 |
| 资源被篡改、身份错误、危险权限、metadata 错误 | 保留原拒绝 |

## 验证与发布条件

新增协议回归先在旧实现上失败，再验证修复后的升级、三种应用身份及版本／profile 矩阵。新建本地合成 PG17 库从 v1 安装和升级，实际生成额外目录，并验证授权与业务结构变化的反例。PRIVATE 独立进程运行其自身测试；仓库完整性检查同时校验 Core、两个分发包及来源 hash。

离线通过不是新云端验收。历史 v2 候选的 runtime／issuer 只读握手属于此前固定候选的证据，不能替代当前 Core／R3 分发包的发布验收。本轮最终测试和独立审查结论记在分支交付与 STA-90；源清单保留原基线及显式增量，不把改动伪装为原封快照。

后续发布须单独选择 schema-v2 的相容入口和目标，核验实际权限、预算与有效期，再完成有限联调及恢复检查。R3 仍需要独立 schema-v3 oracle、迁移与恢复验收；本改动不授权恢复 Q08／S03 或开始生产切换。

English: This is a narrow, version-scoped full-digest compatibility change, not catalog filtering or automatic learning. All application identity, privilege, resource and metadata checks remain mandatory. The additional platform-grant state has a retained provenance WATCH. Local synthetic validation and a pushed branch do not establish cloud acceptance, migration or production deployment.
