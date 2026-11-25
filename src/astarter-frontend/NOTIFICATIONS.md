# Astarter 通知服务

普通用户的流程：绑定 Telegram 或验证接收邮箱 → 发送测试通知 → 开启渠道并保存。用户不需要提供 Bot Token、SMTP、Chat ID。当前发送服务尚未开通，真实收件验收未完成。

## 平台只需开通一次

1. 在官方 [BotFather](https://t.me/BotFather) 中用 `/newbot` 创建 Astarter 专用通知机器人。保留机器人 Token；不要复用正由别的服务管理 webhook 的机器人。当前本地服务用 Telegram 官方 getUpdates 接收 `/start` 深链绑定，不需要公开本机端口。
2. 注册 [Resend](https://resend.com/signup)，验证平台拥有的发件域名，建立发送 API Key。初次可用 Resend 测试发件人发给服务账号本人的邮箱；向其他用户发件之前需要完成正式发件域名验证。账户注册、条款确认和密钥创建由本人操作，密钥不进入聊天或截图。
3. 把以下三项填写到工程内 `.env.notifications.local`（已创建，权限 0600；HTTP 不提供此文件，已加入忽略规则）：

   - `ASTARTER_TELEGRAM_BOT_TOKEN`
   - `ASTARTER_RESEND_API_KEY`
   - `ASTARTER_NOTIFICATION_FROM`，例如 `Astarter <notify@你的已验证域名>`

4. 重载本地 4188 服务后，到“连接与配置 → 通知”操作绑定并实际收件。只有真实 Telegram 私聊的 `/start` 回调，或邮箱中收到的正确验证码，才能建立有效绑定。填地址和保存偏好不能建立绑定。

## 当前实现与验收

- 后端复用 CommerceStore 的 SQLite、HttpOnly 会话、工作区成员校验；绑定/验证/通知偏好/发送队列均按成员与工作区隔离。移除成员同时移除该工作区的通知授权。
- 浏览器把新的模拟委托、成交、信号和风险事件送入服务端队列；恢复页面和切换工作区不重放旧事件。模拟交易仍由当前既有前端演练产生，不能表示已接真实交易所或有离线交易机器人。
- 服务端的投研、策略分析和定时简报任务完成后直接触发通知，不依赖浏览器轮询或页面常驻；短问答不会逐条触发外部通知。
- 队列与去重键持久保存；明确的限流/可重试错误最多重试两次。Telegram 发送结果未知时不盲目重发；邮件使用 Resend 幂等键。API 接收、已发送、邮件已投递、失败、结果未知分别记录。
- SMTP/Telegram 凭据不进入前端、浏览器本地存储或工作区导出；服务器仅使用固定官方发送端点。此预览 API 仅接受 localhost/127.0.0.1 同源请求，不是已部署的公有多用户服务。
- 自动测试使用真实 HTTP 服务和本地模拟供应商，覆盖验证码、防重、工作区隔离、权限撤销、错误重试、SQLite 重开，以及浏览器不参与的任务完成事件。它们不能代替 Telegram/邮箱的真实收件验收。

官方接口：[Telegram 深链](https://core.telegram.org/bots/features#deep-linking)、[Telegram getUpdates](https://core.telegram.org/bots/api#getupdates)、[Resend 发件](https://resend.com/docs/api-reference/emails/send-email)、[Resend 投递结果](https://resend.com/docs/api-reference/emails/retrieve-email)。
