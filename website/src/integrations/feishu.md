---
description: 配置飞书群自定义机器人，将 GitHub 事件发送为文本通知。
---

# 飞书：发送群通知

`feishu:send-text@1` 将文本提交给飞书群自定义机器人。默认配置包含 `feishu: {}`；已有部署需显式加入并加载插件。Webhook 地址和签名密钥都保存在加密 Credential 中。

## 连接机器人

1. 在目标飞书群中添加自定义机器人，复制 Webhook 地址。启用了签名校验时，同时复制签名密钥。
2. 在 Numen 的 **Connections → Credentials** 中创建 **Feishu Bot Webhook**。`Webhook Url` 填完整地址，`Secret` 填可选签名密钥。
3. 创建 **Feishu Custom Bot** Connection，选择刚才的 Credential，保存后启用。
4. 添加 **Send Feishu Text** 流程节点，把 Connection 绑定到 `bot` 槽位。

地址必须为 `https://open.feishu.cn/open-apis/bot/v2/hook/<token>`。插件接受固定飞书 HTTPS 域名和路径，不跟随重定向。Connection 的 READY 表示本地配置就绪；此步骤不发送测试消息，也不验证群机器人是否仍有效。

## GitHub Issue → 飞书通知

先按 [GitHub 指南](./github)创建签名 Credential、auth Connection 和 **GitHub Webhook** Trigger，配置：

```json
{ "events": ["issues"], "actions": ["opened"] }
```

添加 **Send Feishu Text**，将 `Text` 值模式设为 **Reference**，填写 `trigger.body.issue.title`。绑定飞书 Connection 后，发布、激活并启用流程。收到匹配事件时，Run 将 Issue 标题提交给群机器人。

正文也可以使用固定多行文本或前面节点生成的字符串。飞书 `<at …>` 标记会原样传递，可能触发群成员或全员提醒。

## 收据、错误与重试

成功输出为 `{ "accepted": true }`，表示 API 接受提交。失败时在 Run 中查看稳定错误码；远端错误消息、Webhook 地址和密钥不进入错误详情。

| 错误码 | 处理方向 |
| --- | --- |
| `FEISHU_RATE_LIMITED` | 减少发送频率后再决定是否重试 |
| `FEISHU_REJECTED` | 检查签名、机器人关键词及 IP 限制 |
| `FEISHU_HTTP_ERROR` / `FEISHU_NETWORK_ERROR` | 检查网络、代理及机器人地址 |
| `FEISHU_TIMEOUT` | 提交结果可能不确定，先确认群消息再手动重试 |
| `FEISHU_REQUEST_TOO_LARGE` | 缩短正文，完整 JSON 请求必须在 20 KiB 内 |

Action 不声明幂等或可安全自动重试。停用 Connection、轮换 Credential 或卸载插件会中断在途请求，但不能撤回已接收的消息。GitHub 同一 Revision 和 Trigger 的重复 delivery 只创建一个 Run；切换 Revision 会进入新的去重范围。

默认超时 30 秒，覆盖响应体读取，可通过插件 `timeoutMs` 调整（1–300,000 毫秒）。请求字节数包含 JSON 转义和签名字段，响应上限为 64 KiB。请求使用 Runtime 的统一 HTTP 代理配置。

当前提供群自定义机器人文本发送，不含 Lark、应用机器人授权、卡片、图片或附件。本地验证使用模拟接收端，真实群权限、关键词规则和公网投递仍需实际机器人联调。服务约束与签名规则见[官方指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)，完整契约见[包说明](https://github.com/Mahoo12138/numen/blob/main/packages/integration-feishu/README.md)。
