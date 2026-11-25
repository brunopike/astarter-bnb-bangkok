# 证据与来源验证

## 源码包

根 `source-index.json` 固定 Core 来源文件与两个独立分发包来源。`tests/test_repository_package.py` 检查文件 hash、路径、完整导出闭包、共用草稿 fixture 与当前 README 链接。

当前主实现和较早的 PUBLIC 发布快照不能混装；差异在来源索引与[当前状态](../current-status.md)保留。PRIVATE R3 候选没有因进入此仓库获得 Neon profile 或生产准入。

## 运行证据

已有 `audit/` 和 `services/engine/scripts/verify_evidence.py` 保留原控制、封存、订单、成交、仓位及回放验证。只处理明确归属的运行输出，不修改 seal、input manifest 或事件链来改变结果。

回放需要相同有效输入、版本和成本语义；原始数据、模拟样本和模型推断分开标注。尚未验证的输出不能作为已准入结果提供给交易执行。

## 完成条件

区分源码已保存、GitHub 已上传、模块检查通过、独立审查、有限云验证、前端联调、生产发布和资金结果。HTTP 200、部署 READY、进程存活或 COMMITTED 都不能单独证明整条链路可用。

仓库不保存真实 credentials、运行数据库或云运维 receipts；此处没有可以直接重放过去云操作的脚本。
