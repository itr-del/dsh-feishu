# dsh-feishu — 飞书/Lark IM 桥接 DeepSeek Harness

> 可插拔 cordis 插件，把飞书自建机器人接入运行中的
> [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) `web`
> profile —— 通过 `dsh plugin add` 一行安装。

```
┌────────┐   WS    ┌──────────────┐   cordis    ┌──────────┐    LLM    ┌──────────┐
│ 飞书 IM │ ──────> │  本插件      │ ──────────> │ dsh agent │ ────────> │ DeepSeek │
│        │ <────── │              │ <────────── │          │ <──────── │          │
└────────┘   API   └──────────────┘  events     └──────────┘  stream   └──────────┘
```

## 功能

- 一个飞书私聊用户 ↔ 一个持久化 dsh 会话（`feishu:<open_id>`）。
- 多轮对话跨重连保持。
- 把助手回复流回飞书，4000 字分块。
- 过滤 DeepSeek `<|DSML|...>` 工具调用标记。
- 纯 ESM，无需 TypeScript 编译。
- 无遥测、完全本地。

## 安装

### 1. 安装 dsh

```bash
npm install -g @deepseek-ai/dsh
dsh web --help
```

### 2. 安装本插件

```bash
dsh plugin add dsh-feishu
```

会自动装到 `~/.dsh/profiles/web/node_modules/dsh-feishu` 并写入 `cordis.patch.yml`。

### 3. 配置飞书应用

到 <https://open.feishu.cn/app> 创建**自建应用**，复制 `appId` + `appSecret`。

在**事件与回调**里：
- 订阅方式选**使用长连接接收事件/回调**。
- 添加事件 `im.message.receive_v1`。

在**权限**里授予：
- `im:message`
- `im:message.p2p_msg`（私聊必需）

**发布版本** —— 没发布就收不到事件。发布后等约 2 分钟缓存刷新。

### 4. 导出环境变量并启动

```bash
export DEEPSEEK_API_KEY="sk-..."
export FEISHU_APP_ID="cli_..."
export FEISHU_APP_SECRET="..."

dsh web
```

日志里应该看到：

```
[feishu] WebSocket started (appId=cli_xxx)
[feishu] FeishuBridgeService initialized
```

给机器人发私聊消息，agent 会在同一会话里回复。

## 环境变量

| 变量 | 必需 | 默认 | 备注 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是（LLM 调用） | — | <https://platform.deepseek.com> |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | 代理场景 |
| `FEISHU_APP_ID` | 是 | — | 应用控制台里的 `cli_xxx` |
| `FEISHU_APP_SECRET` | 是 | — | 应用控制台 —— **切勿提交** |

## 消息流

1. 用户私聊机器人。
2. 飞书 SDK 触发 `im.message.receive_v1` → 本插件。
3. 插件为 `feishu:<open_id>` 加载/创建 agent。
4. 插件调用 `agent.followup(userMessage)`。
5. agent 回到 `idle` 后，插件读取 `agent.session.events`，过滤 DSML 噪声，通过
   `larkClient.im.message.create(...)` 把回复发回飞书。

## 限制

- **仅文本**。图片/文件/卡片/post 消息未处理。
- **不流式**。turn 结束后再发送回复。
- **暂不支持群聊**。仅私聊。

## 协议

MIT。

## 作者

[itr-del](https://github.com/itr-del) — `13918029394@163.com`

在 Ubuntu 22.04 上集成 dsh 与自托管飞书机器人过程中编写。

English docs: [README.md](./README.md)。