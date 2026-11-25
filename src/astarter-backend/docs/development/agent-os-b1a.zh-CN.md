# Agent OS B1a：四能力离线合同与BTC fixture

本切片只有纯合同和显式测试stub，没有HTTP、应用注册、账户授权、MCP/Skills客户端、数据库、研究worker或模型。默认关闭。它不恢复Q08/S03，也不提供真实报价、执行许可或费用账单。

## 实际入口

- `integrations/assistant_tools.py`：`tool_capabilities(enabled=False)`返回固定market/account/onchain/plan四能力。market仅支持本切片BTC SPOT fixture；其它三项都是NOT_IMPLEMENTED。开启fixture后market仍是not_connected，verified_at为空、scope为空；七种状态词汇不表示本切片实现了live状态。
- `FixtureToolRequest`：只接固定provider选择、request ID、capability与完整BTC/BINANCE/SPOT/BTCUSDT身份。默认OFFLINE_FIXTURE；不接受scope、凭据、工具名、URL、账户、question或预算字段。完整研究HTTP提交合同留B1b/B3。
- `FixtureToolResponse`：选择提供方仍为binance-agent-os，数据的provider/provenance必须为`astarter-fixture-btc-spot-v1`。因此不能把选中的产品入口当作真正Binance MCP来源。
- `project_fixture_result`：纯投影，使用原DataResult/Provenance精度与新鲜度计算。源年龄30秒、接收年龄5秒，沿原包含边界；valid_until为排他截止。过期保留原值/时间并标STALE，未来消费时钟拒绝为INVALID_RESPONSE，不重写时间。该函数不改标外部来源为fixture。
- `tests/stubs/assistant_tools.py`：`AssistantToolsStub(enabled=False)`只在显式开启market时构造本机合成响应，复用既有Binance解析器和FixtureTransport。合成组成根明确转换自己的fixture来源，价格/量/原始hash保持；它不接受任意网络transport。失败可用显式Astarter来源的DataResult做纯投影，保留retry_after而不执行重试。

stub的固定时间/价格来自本机合成输入，并不是API观测。request ID只是本切片关联ID，没有任务落库、收费或持久幂等含义。伪造model_copy/model_construct在运行边界重新进行有界exact-type canonical校验；DTO不是远端签名或授权凭证。

## 边界

公共/私人身份、模型/工具费用、Q08任务状态、目录pin/SQL和交易合同均未修改。只读stub不意味着已经通过多租户、数据库事务、真实工具schema、撤权或订单恢复验收。

三个拟新增HTTP接口`GET /v1/assistant/tool-providers`、`POST /v1/assistant/research-jobs`、`GET /v1/assistant/research-jobs/{job_id}`仍是草案，当前app未注册。B1b需补完整HTTP目录与读取投影；B2/B3/B4分别保留原账户/研究/执行准入。真实连接单独验收，不能用此fixture显示live ready。
