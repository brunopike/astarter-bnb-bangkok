# Agent OS B1b：本地fixture BFF读取

B1b只把B1a的不可执行fixture接到现有BFF。默认应用不增加路由、外部连接或worker；没有MCP、账户、模型、持久化、订单和研究job接口。

## 显式装配与两个读取入口

可信本地组成根先取得B1a `FixtureToolResponse`，构造`AssistantFixtureReadSide(snapshot, clock_ms=...)`，再传给原`create_app(assistant_fixture=..., public_data_only=True, public_data_enabled=True, web_local_origin=...)`。测试使用`tests.stubs.assistant_tools.AssistantToolsStub`生成合成快照；这不是生产启动命令。

只有该装配才注册`GET /v1/assistant/tool-providers`，并把原`GET /v1/data/markets`接到同一内存快照。assistant_fixture默认为None；传入错误类型、Control factory、live/public provider/fetcher/store/collector、cleanup或私人reference runtime均拒绝。不得将本切片接到现用采集器或数据库。

能力目录提供四项独立状态、purpose、数据状态/质量/年龄/覆盖、固定next_action、空私人绑定/scope/verified_at及request ID。market开启fixture仍not_connected，其它三项NOT_IMPLEMENTED。成功和错误目录响应都no-store；GET目录不发现远程工具或刷新令牌。

行情继续使用`AstarterPublicData.v1`，mode=offline_fixture、PUBLIC、real_trading_connected=false、execution_binding=NONE。选择ID为binance-agent-os，实际数据来源为`astarter-fixture-btc-spot-v1`；venue的BINANCE只说明合成品种身份，不能视为Binance MCP回执。

## 时间、覆盖与故障

readside在构造时用B1a canonical做独立有界副本，后续GET只投影，不await provider、不写RAM缓存/文件/数据库、不生成刷新任务。沿用B1a精度/原source-event/receipt/available/hash及消费时钟规则。5秒接收年龄为包含边界，过期标STALE而不更新时间；未来消费时钟返回不可用，失败status/retry_after保留。源日期是合成日期，不伪造当前行情。

仅BTC有fixture。默认三币查询显示partial及ETH/SOL缺口；筛BTC可返回完整fixture；筛ETH返回unavailable，不能填0或别币价格。其余已有公共资源路由保持模式边界但只回不可用，不fallback外部来源。每个HTTP请求有独立request_id与原selection_version，快照事实保持相同。

原loopback Origin、禁止Forwarded、GET-only和严格查询白名单保留。scope/account/URL/enable等查询不能改变状态；错误只回固定码，不回显异常或输入。没有浏览器localStorage授权，也不把数据fresh当连接ready。

## 留给后续

只有能力目录GET已按本模式实现。`POST /v1/assistant/research-jobs`和`GET /v1/assistant/research-jobs/{job_id}`仍未注册；取消/回答、私人数据、真实提供方及持久研究分别按B2/B3验收。B4与Q08原生/S03门禁保持。HTTP测试是进程内ASGI，不代表已经在前端4188联调、监听端口、部署或接通真实工具。
