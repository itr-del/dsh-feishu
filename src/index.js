/**
 * 飞书 × DeepSeek Harness 桥接插件
 *
 * 关键修复 (2026-08-14):
 *   1. agents.create() 必须传 meta.cwd，否则 session 创建失败（错误被 swallow）
 *   2. ctx.on('agent/status') 收到的事件是 { status }，没有 agent 字段
 *      必须 ctx.agents.roots() 遍历找 agent
 *   3. AgentLoop.create(id, options, meta) 是同步的；但 cordis 的 'agents' 服务是 async
 *
 * 架构：
 *   飞书 IM  ──WebSocket──>  飞书 SDK  ──>  本服务 (this)
 *                                            ↓
 *                            ctx.agents.create / .get
 *                                            ↓
 *                            agent.followup(userMessage)
 *                                            ↓
 *                            dsh 内部 agent loop 自动处理
 *                                            ↓
 *                            监听 agent/status === 'idle'
 *                                            ↓
 *                            读 agent.session.events 拿 assistant 回复
 *                                            ↓
 *                            飞书 API 发回用户
 *
 * 设计要点：
 *   - 一个飞书用户（open_id）= 一个 dsh session（"feishu:<open_id>"）
 *   - 用 agent.followup() 排队新 turn（不是 inbox.append）
 *   - 监听 agent/status，running → idle 表示本轮处理完
 *   - 增量读 session.events（lastRepliedSeqBySession 分界）
 */

import { Service } from '@deepseek-ai/cordis'
import * as Lark from '@larksuiteoapi/node-sdk'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'

// ⚠️ dsh 的 ctx.logger 默认走 telemetry OTLP，stdout 看不到
// 用 console.log 双写一份，调试期方便
const log = (ctx, ...args) => {
  const line = '[feishu] ' + args.join(' ')
  console.log(line)
  try { ctx?.logger?.info?.(line) } catch {}
}

export class FeishuBridgeService extends Service {
  // 告诉 cordis：「我开工前请把 agents 服务准备好」
  static inject = ['agents']

  // dsh 的 Service 模式：构造签名是 (ctx, config)
  constructor(ctx, config) {
    super(ctx, 'feishu-bridge')

    // 直接用 config 参数
    this.appId = config.appId
    this.appSecret = config.appSecret
    this.defaultProvider = config.defaultProvider || 'deepseek-official'
    this.defaultModel = config.defaultModel || 'deepseek-v4-flash'

    // 飞书 API 客户端（用来发消息）
    this.larkClient = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
    })

    // session_id -> 上次回复到的 seq（用来增量拿 assistant 消息）
    this.lastRepliedSeqBySession = new Map()

    // session_id -> agent 引用（缓存创建过的 agent）
    this.agentBySession = new Map()

    // 全局 agent lifecycle 钩子（用于清理、统计等）
    ctx.on('agent/disposed', (event) => {
      if (event?.agent?.id) this.agentBySession.delete(event.agent.id)
    })

    // ─── 监听 agent 状态变化 ───
    // ⚠️ 关键：agent/status 是 agent-scoped 事件（this: Scoped<Agent>）
    // 必须在 agent 自己 ctx 里监听，不能用全局 ctx.on
    // 真正的 listener 注册见 handleFeishuMessage 里 agent 创建后的 agent.ctx.on(...)

    // ─── 起飞书 WebSocket 长连接（dsh 关闭时自动断）───
    ctx.effect(() => {
      const dispatcher = new Lark.EventDispatcher({})
      dispatcher.register({
        'im.message.receive_v1': (data) => {
          this.handleFeishuMessage(data).catch((err) => {
            log(this.ctx, `handleFeishuMessage failed: ${err.message}\n${err.stack}`)
          })
        },
      })

      this.wsClient = new Lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
      })
      this.wsClient.start({ eventDispatcher: dispatcher })
      log(this.ctx, `WebSocket started (appId=${this.appId})`)

      return () => {
        try { this.wsClient?.close?.() } catch (e) {}
        log(this.ctx, 'WebSocket closed')
      }
    })

    log(this.ctx, 'FeishuBridgeService initialized')
  }

  // ─────────────────────────────────────────────────────────
  // 飞书收到消息 → dsh agent 处理
  // ─────────────────────────────────────────────────────────
  async handleFeishuMessage(data) {
    const sender = data?.sender?.sender_id
    const message = data?.message
    if (!sender?.open_id || !message?.message_id) {
      log(this.ctx, 'incomplete event data')
      return
    }

    const openId = sender.open_id

    // 只处理文本消息
    if (message.message_type !== 'text') {
      await this.sendFeishuMessage(openId, '⏳ 暂只支持文本消息（图片/文件后续支持）')
      return
    }

    let text
    try {
      text = JSON.parse(message.content).text
    } catch {
      await this.sendFeishuMessage(openId, '❌ 消息解析失败')
      return
    }

    if (!text || !text.trim()) return

    log(this.ctx, `recv from ${openId}: ${text.slice(0, 80)}`)

    // 构造 session_id
    const sessionId = `feishu:${openId}`

    // 找或创建 agent
    let agent = this.agentBySession.get(sessionId)
    if (!agent) {
      // ⚠️ 关键修复：
      //   1. 必须传 meta.cwd
      //   2. 必须传 setup(installModelSelection) — 否则 agent 不知道用什么 model，永远 idle
      //   3. agent 创建后必须用 agent.ctx.on('agent/status', ...) 注册 idle 监听
      //      因为 agent/status 是 agent-scoped 事件，全局 ctx.on 接不到
      //   4. 必须先 resume 再 create：磁盘已有同名持久化 session 时 create 会
      //      抛 id collision（"already has a persisted log on disk"）
      try {
        const handle = await this.getOrCreateAgent(sessionId)
        agent = handle.agent
        this.agentBySession.set(sessionId, agent)
        this.lastRepliedSeqBySession.set(sessionId, 0)

        // ⚠️ 在 agent 自己的 ctx 上监听 status 变化
        // payload: { agent, status: 'idle' | 'running' }
        agent.ctx.on('agent/status', ({ agent: a, status }) => {
          log(this.ctx, `status event: ${status} (agent=${a?.id})`)
          if (status !== 'idle') return
          this.handleAgentIdle(a).catch((err) =>
            log(this.ctx, `handleAgentIdle failed: ${err.message}\n${err.stack}`)
          )
        })

        // 捕获 agent 内部错误（turn 失败、LLM 失败等）
        agent.ctx.on('agent/error', (payload) => {
          const err = payload?.error
          log(this.ctx, `agent/error: turn=${payload?.turn} step=${payload?.step} ${err?.message}\n${err?.stack ?? ''}`)
        })

        log(this.ctx, `agent ready for ${openId} (id=${agent.id}, mode=${handle.mode})`)
      } catch (err) {
        log(this.ctx, `create agent failed: ${err.message}\n${err.stack}`)
        await this.sendFeishuMessage(openId, `❌ 创建会话失败: ${err.message}`)
        return
      }
    }

    // 构造 UserMessage
    const userMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })

    // 排队新 turn
    try {
      agent.followup(userMessage)
      log(this.ctx, `queued to agent ${sessionId}`)
    } catch (err) {
      log(this.ctx, `followup failed: ${err.message}`)
      await this.sendFeishuMessage(openId, `❌ 提交失败: ${err.message}`)
    }
  }

  // ─────────────────────────────────────────────────────────
  // 找或创建 agent：磁盘已有同名持久化 session 时 resume，否则 create
  // ─────────────────────────────────────────────────────────
  async getOrCreateAgent(sessionId) {
    const agentOptions = {
      provider: this.defaultProvider,
      model: this.defaultModel,
    }
    const setup = (agentCtx) => {
      installModelSelection(agentCtx, {
        current: {
          provider: this.defaultProvider,
          model: this.defaultModel,
        },
        assembled: undefined,
      })
    }

    // 1. 先试 resume：磁盘有持久化 session 时，create 会抛 id collision
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      })
      log(this.ctx, `resumed existing session ${sessionId}`)
      return { ...handle, mode: 'resume' }
    } catch (err) {
      log(this.ctx, `resume failed (${err?.message}), falling back to create`)
    }

    // 2. create：全新 session（磁盘无记录）
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    })
    return { ...handle, mode: 'create' }
  }

  // ─────────────────────────────────────────────────────────
  // agent 跑完一轮 → 把 assistant 回复发回飞书
  // ─────────────────────────────────────────────────────────
  async handleAgentIdle(agent) {
    const sessionId = agent.id
    // 只处理我们创建的飞书 session
    if (!String(sessionId).startsWith('feishu:')) return

    const lastSeq = this.lastRepliedSeqBySession.get(sessionId) ?? 0

    // 增量取所有"新产生"的 assistant/message
    const newAssistantMessages = agent.session.events.filter(
      (ev) => ev.type === 'assistant/message' && ev.seq > lastSeq
    )

    if (newAssistantMessages.length === 0) {
      log(this.ctx, `agent idle but NO assistant/message events (total events=${agent.session.events.length}); turn may have failed`)
      return
    }

    const latestSeq = newAssistantMessages[newAssistantMessages.length - 1].seq
    this.lastRepliedSeqBySession.set(sessionId, latestSeq)

    // 提取文本（过滤掉 DSML tool call 标签和 thinking 标签）
    const text = newAssistantMessages
      .flatMap((ev) => ev.data.message.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      // 移除 DeepSeek DSML 工具调用标签
      .replace(/<\|｜DSML｜[^>]*>[\s\S]*?<\/\|｜DSML｜[^>]*>/g, '')
      .replace(/<\|｜[^|]*｜>/g, '')
      .trim()

    if (!text) return

    const openId = String(sessionId).slice(7)

    log(this.ctx, `agent idle, replying to ${openId}: ${text.slice(0, 80)}`)

    try {
      await this.sendFeishuMessage(openId, text)
    } catch (err) {
      log(this.ctx, `send failed: ${err.message}`)
    }
  }

  // ─────────────────────────────────────────────────────────
  // 飞书发消息
  // ─────────────────────────────────────────────────────────
  async sendFeishuMessage(openId, text) {
    if (!text) return

    const chunks = this.chunkText(text, 4000)

    for (const chunk of chunks) {
      try {
        const result = await this.larkClient.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: openId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
        })
        log(this.ctx, `feishu sent message_id=${result?.data?.message_id} to ${openId}`)
      } catch (err) {
        log(this.ctx, `im.message.create failed: ${err.message} (chunk size=${chunk.length})`)
        throw err
      }
    }
  }

  chunkText(text, maxLen) {
    if (text.length <= maxLen) return [text]
    const chunks = []
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen))
    }
    return chunks
  }
}

export default FeishuBridgeService