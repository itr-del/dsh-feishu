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
 *
 * Watchdog (2026-08-16):
 *   - dsh agent loop 对 LLM 流式响应 hang 死没有超时保护（for-await stream 无 timeout）
 *   - 飞书 plugin 是 daemon 模式，hang 会持续到下次重启
 *   - 每个 followup 启动一个 timer（默认 10 分钟，DSH_FEISHU_WATCHDOG_TIMEOUT_MS 覆盖）
 *   - 超时后强制 agent.cancel() + 通知用户 + 清理 timer
 *   - 在 handleAgentIdle / agent/error / agent/disposed 三处清除 timer（避免误杀）
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
    this.presetId = config.presetId || 'standard'

    // 飞书 API 客户端（用来发消息）
    this.larkClient = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
    })

    // session_id -> 上次回复到的 seq（用来增量拿 assistant 消息）
    this.lastRepliedSeqBySession = new Map()

    // session_id -> agent 引用（缓存创建过的 agent）
    this.agentBySession = new Map()

    // session_id -> watchdog timer（防 dsh agent hang 死）
    // 超时后强制 agent.cancel() 让 agent 回到 idle，下次消息能继续处理
    this.watchdogBySession = new Map()
    // 默认 10 分钟；可通过环境变量 DSH_FEISHU_WATCHDOG_TIMEOUT_MS 覆盖（毫秒）
    const envTimeout = Number(process.env.DSH_FEISHU_WATCHDOG_TIMEOUT_MS)
    this.watchdogTimeoutMs =
      Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 10 * 60 * 1000

    // session_id -> ask_user_question 轮询 timer（见 §交互式提问桥接）
    this.askWatchBySession = new Map()
    // 已转投到飞书的 ask_user_question callId（避免重复发送）
    this.bridgedAskCalls = new Set()
    // 轮询间隔（毫秒）
    this.askWatchIntervalMs = 2000

    // ─── 进度回传（长任务期间不再全程静默）─────────────────────
    // 旧行为：只在 agent 转 idle 时才回消息 ⇒ agent 埋头干 10 分钟，
    //         用户一个字都收不到，看起来像"卡死了"。这也是「总是超时」观感的来源之一。
    // 新行为：turn 跑超过 progressAfterMs 后，每 progressIntervalMs 把新产出的
    //         assistant 正文增量发一次「进行中」消息（与最终回复共用同一个 seq 游标，
    //         不会重复发同一段文字）。
    this.turnArmedAtBySession = new Map()
    this.lastProgressAtBySession = new Map()
    this.progressFlushedBySession = new Set()
    const envAfter = Number(process.env.DSH_FEISHU_PROGRESS_AFTER_MS)
    this.progressAfterMs = Number.isFinite(envAfter) && envAfter >= 0 ? envAfter : 45 * 1000
    const envInterval = Number(process.env.DSH_FEISHU_PROGRESS_INTERVAL_MS)
    this.progressIntervalMs =
      Number.isFinite(envInterval) && envInterval > 0 ? envInterval : 30 * 1000

    // ⚠️ 飞书环境约束：ask_user_question / exit_plan_mode 是「交互式 UI 工具」，
    //    答案只走 dsh web 的浏览器端（dsh-host-apiproxy 注册的 userQuestions
    //    provider → muxQueues → 浏览器 WebSocket）。飞书桥不在那条链路上，
    //    调用必然死等到 watchdog 超时，用户一个字都看不到。
    //    随每条用户消息注入一句约束，让 agent 把问题写进正文。
    this.envNotice =
      config.envNotice ||
      '\n\n---\n[飞书桥环境约束] 你正在飞书私聊里工作。ask_user_question 和 ' +
        'exit_plan_mode 这类「交互式 UI 工具」在此环境无效：它们的答案只走 dsh web ' +
        '的浏览器端，飞书这边收不到，调用后只会一直死等到超时被取消。需要我确认、' +
        '选择或拍板时，请把问题和选项直接写在回复正文里，我会在下一轮回答你。'

    // 全局 agent lifecycle 钩子（用于清理、统计等）
    ctx.on('agent/disposed', (event) => {
      if (event?.agent?.id) {
        this.agentBySession.delete(event.agent.id)
        this.cancelWatchdog(event.agent.id)
        this.cancelAskWatcher(event.agent.id)
      }
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
          // error 后 agent 会转 idle，但保险起见立即清掉 watchdog
          this.cancelWatchdog(sessionId)
        })

        log(this.ctx, `agent ready for ${openId} (id=${agent.id}, mode=${handle.mode})`)
      } catch (err) {
        log(this.ctx, `create agent failed: ${err.message}\n${err.stack}`)
        await this.sendFeishuMessage(openId, `❌ 创建会话失败: ${err.message}`)
        return
      }
    }

    // 构造 UserMessage（附带飞书环境约束，见 constructor 里的 envNotice）
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: text + this.envNotice }],
      source: { kind: 'user' },
    })

    // 排队新 turn
    try {
      agent.followup(userMessage)
      log(this.ctx, `queued to agent ${sessionId}`)
      // ⚠️ 启动 watchdog：dsh agent loop 对 LLM 流式 hang 死没保护
      // 10 分钟内没转 idle 就强制 cancel + 通知用户
      this.startWatchdog(sessionId, agent, openId)
    } catch (err) {
      log(this.ctx, `followup failed: ${err.message}`)
      await this.sendFeishuMessage(openId, `❌ 提交失败: ${err.message}`)
    }
  }

  // ─────────────────────────────────────────────────────────
  // 找或创建 agent：磁盘已有同名持久化 session 时 resume，否则 create
  // 关键：必须 mount agent preset（如 standard），否则 agent 没有工具
  // （Web 模式把所有 tool-* 行 disabled，工具只能通过 preset 装配）
  // ─────────────────────────────────────────────────────────
  async getOrCreateAgent(sessionId) {
    const agentOptions = {
      provider: this.defaultProvider,
      model: this.defaultModel,
    }
    const presets = this.ctx.get('agentPresets')
    const setup = async (agentCtx) => {
      installModelSelection(agentCtx, {
        current: {
          provider: this.defaultProvider,
          model: this.defaultModel,
        },
        assembled: undefined,
      })
      // ⚠️ 不 mount preset → agent 的工具解析到空全局层 → tools=0
      if (presets !== undefined) {
        await presets.mount(agentCtx, this.presetId)
      } else {
        log(this.ctx, 'WARN: agentPresets service not found; agent will have NO tools')
      }
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
      meta: {
        cwd: process.cwd(),
        ...(this.presetId ? { agentPreset: this.presetId } : {}),
      },
      agentOptions,
      setup,
    })
    return { ...handle, mode: 'create' }
  }

  // ─────────────────────────────────────────────────────────
  // 抽取 seq > afterSeq 的 assistant 正文（进度回传与最终回复共用）
  // 返回 { text, latestSeq }；latestSeq === null 表示没有新的 assistant/message
  // ─────────────────────────────────────────────────────────
  collectAssistantText(events, afterSeq) {
    const msgs = (events ?? []).filter(
      (ev) => ev.type === 'assistant/message' && ev.seq > afterSeq
    )
    if (msgs.length === 0) return { text: '', latestSeq: null }

    const latestSeq = msgs[msgs.length - 1].seq

    // 提取文本（过滤掉 DSML tool call 标签和 thinking 标签）
    const text = msgs
      .flatMap((ev) => ev.data.message.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      // 移除 DeepSeek DSML 工具调用标签
      .replace(/<\|｜DSML｜[^>]*>[\s\S]*?<\/\|｜DSML｜[^>]*>/g, '')
      .replace(/<\|｜[^|]*｜>/g, '')
      // 移除模型误输出的 XML 风格工具调用块（<tool_calls>...</tool_calls>）
      .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
      .replace(/<\/?invoke[^>]*>/g, '')
      .replace(/<\/?parameter[^>]*>/g, '')
      .trim()

    return { text, latestSeq }
  }

  // ─────────────────────────────────────────────────────────
  // agent 跑完一轮 → 把 assistant 回复发回飞书
  // ─────────────────────────────────────────────────────────
  async handleAgentIdle(agent) {
    const sessionId = agent.id
    // 只处理我们创建的飞书 session
    if (!String(sessionId).startsWith('feishu:')) return

    // 任何 idle 都清除 watchdog（不管是正常完成、错误、还是被 watchdog cancel 触发的）
    this.cancelWatchdog(sessionId)

    const lastSeq = this.lastRepliedSeqBySession.get(sessionId) ?? 0
    const { text, latestSeq } = this.collectAssistantText(agent.session.events, lastSeq)

    if (latestSeq === null) {
      // 本轮没有任何新的 assistant/message
      if (this.progressFlushedBySession.has(sessionId)) {
        // 但期间已经发过「进行中」进度消息 → 补一个收尾标记，避免用户以为没跑完
        log(this.ctx, `agent idle; progress already flushed, sending completion marker (${sessionId})`)
        this.sendFeishuMessage(
          String(sessionId).slice(7),
          '✅ 本轮已完成（正文见上方进度消息）。'
        ).catch((err) => log(this.ctx, `completion marker failed: ${err.message}`))
      } else {
        log(this.ctx, `agent idle but NO assistant/message events (total events=${agent.session.events.length}); turn may have failed`)
      }
      return
    }

    this.lastRepliedSeqBySession.set(sessionId, latestSeq)

    // 如果清洗后只剩工具调用骨架（没有实质内容），丢弃本轮
    if (!text) {
      log(this.ctx, `agent idle but reply text empty after cleaning (new messages until seq=${latestSeq})`)
      return
    }

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

  // ─────────────────────────────────────────────────────────
  // Watchdog: 防 dsh agent hang 死
  //
  // dsh agent loop 的 step() 对 LLM 流式响应没有任何超时保护：
  //   for await (const chunk of stream) { signal.throwIfAborted() }
  //   - 没有 Promise.race(stream, timeout)
  //   - 没有心跳检测（60s 没新 chunk 就 abort）
  //   - retry 只对 error 触发，hang 不是 error
  //
  // 飞书 plugin 模式下 dsh 是 daemon，hang 会持续到下次重启。
  // 我们的解法：每次 followup 启动一个 timer，超时后强制 agent.cancel()
  //   - cancel → phase.abort.abort() → 下个 chunk 抛 AbortError → turn 进入 error → agent/status 转 idle
  //   - turn 产物会丢，但 session 上下文保留，下次 followup 正常继续
  //   - 用户收通知「已自动取消，请重发」，体验可接受
  //
  // 清除 watchdog 的 3 个时机（任何一个触发都清，避免误杀活跃 turn）：
  //   1. handleAgentIdle（最常见：agent 正常完成 / 被 cancel 后转 idle）
  //   2. agent/error（LLM 报错、turn 失败）
  //   3. agent/disposed（session 销毁）
  // ─────────────────────────────────────────────────────────
  startWatchdog(sessionId, agent, openId) {
    // 已有 timer 先清掉（每次 followup 都重新计时，包括同 session 多次消息）
    this.cancelWatchdog(sessionId)

    const timeoutMs = this.watchdogTimeoutMs
    const timer = setTimeout(() => {
      // ⚠️ 双保险：timer 已 fire 之前如果被 clearTimeout 过，setTimeout 的回调还会跑吗？
      // Node.js 不会跑（已 clear 的 timer 不会触发）。但保险起见先 remove
      this.watchdogBySession.delete(sessionId)

      log(
        this.ctx,
        `watchdog timeout (${Math.round(timeoutMs / 1000)}s) for ${sessionId}, forcing cancel`
      )

      // 1) 强制 cancel agent
      try {
        agent.cancel({ kind: 'watchdog-timeout' })
        log(this.ctx, `agent cancelled by watchdog: ${sessionId}`)
      } catch (err) {
        log(this.ctx, `watchdog cancel failed: ${err.message}`)
      }

      // 2) 通知用户（fire-and-forget，不阻塞 watchdog 流程）
      const minutes = Math.round(timeoutMs / 60000)
      this.sendFeishuMessage(
        openId,
        `⏳ 上轮思考超过 ${minutes} 分钟未完成，已自动取消。\n` +
          `请重新发消息重试（历史上下文已保留）。`
      ).catch((err) =>
        log(this.ctx, `watchdog notify failed: ${err.message}`)
      )
    }, timeoutMs)

    this.watchdogBySession.set(sessionId, timer)
    log(
      this.ctx,
      `watchdog armed (${Math.round(timeoutMs / 1000)}s) for ${sessionId}`
    )

    // 同步启动「交互式提问桥接」轮询（ask_user_question 在飞书是死锁，见下）
    this.startAskWatcher(sessionId, agent, openId)
  }

  // ─────────────────────────────────────────────────────────
  // 交互式提问桥接：ask_user_question 在飞书-only 环境必然死锁
  //
  // 机制（扒源码验证）：
  //   dsh-tool-ask-user → ctx.userQuestions.ask()
  //   → 唯一的 provider 由 dsh-host-apiproxy 注册，
  //     它把 question/requested 推进 muxQueues（浏览器 WebSocket 队列）
  //   → 没有浏览器客户端连着 = 没人应答 = 死等，直到 signal abort
  //     （就是 watchdog 那条超时）
  //
  // 对策：轮询 session 事件，发现「未结算的 ask_user_question 调用」时：
  //   1) 把问题与选项渲染成文本发到飞书 —— 用户一定看得到
  //   2) 立即 agent.cancel() 解开阻塞。cancel 会在 session 里落一条 isError
  //      的 tool result（历史自洽、不会留下悬空 tool_call），agent 转 idle，
  //      用户的下一条消息作为新 turn 带上答案继续。
  // ─────────────────────────────────────────────────────────
  startAskWatcher(sessionId, agent, openId) {
    this.cancelAskWatcher(sessionId)
    // 记录本轮起始时间：进度回传以「本轮已跑多久」为触发条件
    this.turnArmedAtBySession.set(sessionId, Date.now())
    this.lastProgressAtBySession.set(sessionId, Date.now())
    this.progressFlushedBySession.delete(sessionId)
    const timer = setInterval(() => {
      this.watchTurn(sessionId, agent, openId).catch((err) =>
        log(this.ctx, `turn watcher failed: ${err.message}`)
      )
    }, this.askWatchIntervalMs)
    this.askWatchBySession.set(sessionId, timer)
  }

  async watchTurn(sessionId, agent, openId) {
    // 1) 优先处理「交互式提问死锁」——有未结算的 ask_user_question 就转投飞书
    if (await this.bridgePendingQuestion(sessionId, agent, openId)) return
    // 2) 其次做进度回传（长任务期间让用户看得见进展）
    await this.maybeFlushProgress(sessionId, agent, openId)
  }

  // ─────────────────────────────────────────────────────────
  // 进度回传：turn 超过 progressAfterMs 仍未结束，就把新产出的正文增量发出去
  // 与最终回复共用 lastRepliedSeqBySession 游标 ⇒ 同一段文字不会发两遍
  // ─────────────────────────────────────────────────────────
  async maybeFlushProgress(sessionId, agent, openId) {
    const now = Date.now()
    const armedAt = this.turnArmedAtBySession.get(sessionId) ?? now
    if (now - armedAt < this.progressAfterMs) return

    const lastAt = this.lastProgressAtBySession.get(sessionId) ?? 0
    if (now - lastAt < this.progressIntervalMs) return

    const lastSeq = this.lastRepliedSeqBySession.get(sessionId) ?? 0
    const { text, latestSeq } = this.collectAssistantText(agent?.session?.events ?? [], lastSeq)
    if (latestSeq !== null) this.lastRepliedSeqBySession.set(sessionId, latestSeq)
    if (!text || text.length < 15) return

    this.lastProgressAtBySession.set(sessionId, now)
    this.progressFlushedBySession.add(sessionId)
    log(this.ctx, `progress flush (${text.length} chars) for ${sessionId}`)
    await this.sendFeishuMessage(openId, `⏳ 进度更新（还在跑）…\n\n${text}`)
  }

  cancelAskWatcher(sessionId) {
    const timer = this.askWatchBySession.get(sessionId)
    if (timer) {
      clearInterval(timer)
      this.askWatchBySession.delete(sessionId)
    }
  }

  async bridgePendingQuestion(sessionId, agent, openId) {
    const events = agent?.session?.events ?? []

    // 已结算的 callId（tool/result 里带 source.callId）
    const settled = new Set()
    for (const ev of events) {
      if (ev.type !== 'tool/result') continue
      const callId = ev.data?.message?.source?.callId
      if (callId) settled.add(callId)
    }

    // 从尾部往前找最近一次 ask_user_question 调用
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.type !== 'tool/call' || ev.data?.name !== 'ask_user_question') continue
      const callId = ev.data.callId
      if (!callId || settled.has(callId)) return false
      if (this.bridgedAskCalls.has(callId)) return false
      this.bridgedAskCalls.add(callId)

      let questions = []
      try {
        questions = JSON.parse(ev.data.arguments ?? '{}')?.questions ?? []
      } catch (err) {
        log(this.ctx, `ask watcher: cannot parse arguments (${err.message})`)
      }

      log(
        this.ctx,
        `ask_user_question detected (callId=${callId}, ${questions.length} question(s)) → bridging to Feishu`
      )

      await this.sendFeishuMessage(openId, this.renderQuestions(questions))

      try {
        agent.cancel({ kind: 'feishu-bridged-ask-user' })
        log(this.ctx, `agent cancelled to unblock ask_user_question: ${sessionId}`)
      } catch (err) {
        log(this.ctx, `ask watcher cancel failed: ${err.message}`)
      }
      return true
    }
    return false
  }

  renderQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0) {
      return (
        '🙋 DSH 想问你一个问题，但该交互式提问在飞书里收不到。\n' +
        '请直接补一条消息说明你的想法，我转达给它继续。'
      )
    }
    const lines = ['🙋 DSH 需要你拍板（飞书里交互式提问不通，已转成文字）:', '']
    questions.forEach((q, i) => {
      const header = q.header ? `[${q.header}] ` : ''
      lines.push(`${i + 1}. ${header}${q.question ?? ''}`)
      const options = Array.isArray(q.options) ? q.options : []
      options.forEach((o, j) => {
        const letter = String.fromCharCode(65 + j)
        lines.push(
          `     ${letter}. ${o.label ?? ''}${o.description ? ` —— ${o.description}` : ''}`
        )
      })
      if (q.multi_select) lines.push('     （可多选）')
      lines.push('')
    })
    lines.push('→ 直接回一条消息给我（回字母/编号即可，也可以自由发挥），我转达给 DSH 继续。')
    return lines.join('\n')
  }

  cancelWatchdog(sessionId) {
    const timer = this.watchdogBySession.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.watchdogBySession.delete(sessionId)
      log(this.ctx, `watchdog cancelled for ${sessionId}`)
    }
    // turn 结束（正常 / 报错 / 被 cancel）→ 提问轮询也一并停掉
    this.cancelAskWatcher(sessionId)
  }
}

export default FeishuBridgeService