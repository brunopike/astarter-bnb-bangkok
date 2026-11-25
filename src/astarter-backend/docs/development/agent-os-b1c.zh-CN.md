# B1c：合成回执离线准入准备

本轮仅为fixture/stub切片。它不核实官方MCP schema、真实REST或MCP连接，不执行真实工具，不处理账户、模型、现用数据库或供应商费用；Q08与S03仍暂停。真实B1c只读准入须另有实际工具schema、明确IO预算、回执和清理证据。

## 使用已有路径

`integrations.assistant_fixture_receipts.admit_fixture_receipt(request, body, expected_transport=..., now_ms=...)`是纯函数。`request`沿用B1a `FixtureToolRequest`；body是本地合成JSON bytes。可信本地组成根指定`rest_fixture`或`mcp_fixture`，不能让响应正文选择期望通道。函数不接transport、URL、凭据、store或模型，也没有HTTP入口或启动脚本。

成功返回原B1a `FixtureToolResponse`，随后沿用B1b `AssistantFixtureReadSide`及`create_app(assistant_fixture=..., public_data_only=True, public_data_enabled=True)`。既有目录GET与markets GET保持原合同和默认关闭行为；不新增第二缓存或后台刷新。

## 封闭本地格式

本地schema为`AstarterAssistantFixtureReceipt.v1`，必要字段为：

| 字段 | 允许值或合同 |
|---|---|
| transport | `rest_fixture`或`mcp_fixture`，二者必须与组成根期望相同 |
| tool_id | 分别固定`astarter.fixture.rest.btc-24h.v1`、`astarter.fixture.mcp.btc-24h.v1` |
| coverage | `BINANCE_SPOT_24H_STATISTICS`，不满足连续K线、盘口或执行报价 |
| tenant_scope | `PUBLIC` |
| request_id | 必须与可信请求、内层response的ID一致 |
| response | 原B1a完整快照或失败DTO，只有已显式启用的market可提供回执 |

以上两个tool ID与该schema均由Astarter合成，**不声称它们是Binance工具名、官方schema或MCP JSON-RPC格式**。`readOnlyHint`等自报注解不产生权限；未登记工具、工具写操作、任意URL、私人绑定、scope和额外字段均拒绝。旧REST来源不能改名冒充fixture或MCP。

原有有界JSON预解析拒绝重复键、空/非object/非有限/过大输入；随后对原bytes作strict JSON schema校验，不先把布尔值或数字字符串转换为retry浮点值，JSON数组仍按原tuple合同验证。DTO重验不信任伪造实例。新增回执入口保留旧Binance适配器的正价格与统计窗口顺序校验，不能只靠DataResult结构合法就准入为OK。回执错误统一固定`ResearchRejected`代码，不回显正文、工具字符串或验证输入。

## 时间、失败和显示

来源仍为`astarter-fixture-btc-spot-v1`，目的固定`OFFLINE_FIXTURE`，`execution_authorized=false`。目录transport仍为`fixture`、market仍`not_connected`、`verified_at`和私人权限为空；两个合成通道不解锁任何真实ready状态。

准入时核对完整BTC/BINANCE/SPOT/BTCUSDT身份与原request绑定，并在消费时复用B1a时间规则。消费时间早于回执checked_at时拒绝；合法旧回执超期则返回stale，不改原event/receipt/available/valid_until、价格精度、窗口或raw数据hash。回执包装不是签名/认证凭证，不是任务幂等、Q08证据登记或账单。

`RATE_LIMITED/TIMEOUT/INVALID_RESPONSE`等失败仍是失败，retry hint原样保留；没有自动重试、外部fallback、未知扣费退款或“免费模型”假设。真实HTTP/DNS/MCP/账户/模型预算均为0，本切片不新增收费单位或模拟账本。

## 离线验收范围

新单元测试覆盖准入、通道/工具/schema/覆盖/请求/身份绑定、严格时间、失败元数据、越权字段、原始JSON边界及DTO伪造。ASGI测试将两个通道分别送入原B1a/B1b目录与行情GET，验证fresh→stale、缺项、失败、重复GET无抓取与未开放研究/执行路由。

与既有B1a/B1b和公共HTTP在同一pytest进程验证；兼容组只使用临时合成SQLite，B1c运行路径本身不访问DB。类型/静态、阻断IO和两个独立审查结论以项目任务证据为准。此文档不表示浏览器/代理、真实工具、官方schema、长测、云端或Q08原生验收已完成。
