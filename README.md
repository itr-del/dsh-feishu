# dsh-feishu — Feishu (Lark) IM bridge for DeepSeek Harness

> A pluggable **cordis plugin** that wires the **Feishu / Lark** WebSocket gateway
> into a running **[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)**
> `web` profile. Users can DM a Feishu bot and the message flows into a real dsh
> agent; the agent's reply is streamed back into the same Feishu chat.

```
┌────────┐   WS    ┌──────────────┐   cordis    ┌──────────┐    LLM    ┌──────────┐
│ Feishu │ ──────> │  this plugin │ ──────────> │ dsh agent │ ────────> │ DeepSeek │
│  IM    │ <────── │              │ <────────── │          │ <──────── │          │
└────────┘   API   └──────────────┘  events     └──────────┘  stream   └──────────┘
```

## Why this exists

dsh ships with a Web UI (`dsh web`) and a terminal UI but no IM gateway out of
the box. This plugin adds the missing bridge so a Feishu self-built bot becomes
a first-class front-end to your dsh agent — the same one running in your
browser at `http://127.0.0.1:3080`. Every DM from a Feishu user is a new
turn; every assistant reply is forwarded back into Feishu as text messages
(DSML tool-call markers are filtered out before sending).

## Features

- One Feishu DM user ↔ one persistent dsh session (`feishu:<open_id>`).
- Multi-turn conversations across reconnects (session is resumed, not recreated).
- Listens to `agent/status` (scoped) to know when the agent finished a turn.
- Streams `assistant/message` blocks back into Feishu, chunking at 4000 chars.
- Filters DeepSeek `<|DSML|...>` tool-call markers from the outbound text.
- Pure ESM, no TypeScript compile step needed.
- No telemetry or external calls — fully local.

## Installation

### 1. Install dsh if you haven't already

```bash
npm install -g @deepseek-ai/dsh
dsh web --help
```

### 2. Clone this plugin into a known location

```bash
git clone https://github.com/<your-org>/dsh-feishu
cd dsh-feishu
```

### 3. Install plugin dependencies into your dsh web profile

```bash
# dsh stores profiles under ~/.dsh/profiles/<name>/. We install as
# "@local/dsh-feishu" so dsh can resolve it from the cordis.patch.yml.
mkdir -p ~/.dsh/profiles/web/node_modules/@local
ln -s "$(pwd)" ~/.dsh/profiles/web/node_modules/@local/dsh-feishu
```

### 4. Install the runtime SDKs the plugin needs

```bash
cd ~/.dsh/profiles/web/node_modules/@local/dsh-feishu
pnpm install
# (or: npm install)
```

### 5. Configure your Feishu app

1. Go to **https://open.feishu.cn/app** and create a **Custom App** (自建应用).
2. Copy `appId` and `appSecret` — you'll need them next.
3. Under **Event Subscriptions (事件与回调)**:
   - Set **Subscription mode (订阅方式)** to **Receive events via persistent connection (使用长连接接收事件/回调)**.
   - Add the event **`im.message.receive_v1`**.
4. Under **Permissions (权限)**, grant:
   - `im:message`
   - `im:message.group_at_msg` (for group chats, optional)
   - `im:message.p2p_msg` (for DMs, required)
5. **Publish a version (发布版本)** — without this, the bot cannot receive events.
6. Wait ~2 minutes for the cache to refresh.

### 6. Write the patch file

Create `~/.dsh/profiles/web/cordis.patch.yml` (merge with whatever you have):

```yaml
plugins:
  # Activate dsh-llm-deepseek (bundled but dormant by default)
  - id: llm-deepseek
    name: '@deepseek-ai/dsh-llm-deepseek'
    config:
      apiKeyEnv: DEEPSEEK_API_KEY
      baseURL: !!js process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
      thinking: enabled
      reasoningEffort: high
      models:
        - id: deepseek-v4-flash
          contextWindow: 128000

  # Insert the Feishu bridge
  - insert:
      - id: feishu-bridge
        name: '@local/dsh-feishu'
        config:
          appId: !!js process.env.FEISHU_APP_ID
          appSecret: !!js process.env.FEISHU_APP_SECRET
          defaultProvider: 'deepseek-official'
          defaultModel: 'deepseek-v4-flash'
```

### 7. Export env vars and run

```bash
export DEEPSEEK_API_KEY="sk-your-real-key"
export FEISHU_APP_ID="cli_your_app_id"
export FEISHU_APP_SECRET="your_app_secret"

dsh web
```

You should see in the logs:

```
[feishu] WebSocket started (appId=cli_xxx)
[feishu] FeishuBridgeService initialized
[info]: [ '[ws]', 'ws client ready' ]
```

DM the bot anything and the agent will reply in the same conversation.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | yes (for LLM calls) | — | Get from https://platform.deepseek.com |
| `DEEPSEEK_BASE_URL` | no | `https://api.deepseek.com` | Useful for proxies |
| `FEISHU_APP_ID` | yes | — | `cli_xxx` from app console |
| `FEISHU_APP_SECRET` | yes | — | From app console — **never commit** |

## How a message flows

1. User DMs the bot "Hello".
2. Feishu SDK WebSocket fires `im.message.receive_v1` event → this plugin.
3. Plugin pulls the agent for `feishu:<open_id>` (creates on first message).
4. Plugin wraps the user text in a `createUserMessage(...)` and calls
   `agent.followup(userMessage)`.
5. dsh's internal loop picks up the turn, asks DeepSeek for a stream.
6. When the agent flips back to `idle`, the plugin sees
   `agent.ctx.on('agent/status', ({ status }) => status === 'idle')`.
7. Plugin reads `agent.session.events`, filters for new `assistant/message`
   blocks, strips DSML tool-call noise, and calls
   `larkClient.im.message.create(...)` to post the reply back to Feishu.

## Limitations / TODO

- **Text only.** Image / file / card / post messages are not yet handled
  (the bot will reply "⏳ 暂只支持文本消息").
- **No streaming.** We wait for the agent to finish a turn before sending.
  Real incremental streaming is on the roadmap.
- **No groups yet.** Only 1:1 DMs are wired up.
- **No image-content filter:** DeepSeek adapter is text-only — do not send
  images to the agent via Feishu (it will throw `UNSUPPORTED_CONTENT`).

## License

MIT.

## Author

[itr-del](https://github.com/itr-del) — `13918029394@163.com`

Built while integrating dsh with a self-hosted Feishu bot on Ubuntu 22.04.

If this plugin helped you, ⭐ the repo and consider opening a PR to
[Dominic789654/awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness)
to list it under "Channel / IM Bridges".
