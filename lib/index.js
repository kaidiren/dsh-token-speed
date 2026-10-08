// dsh-token-speed — host 半边
//
// 目标：GUI 底部状态栏里那个「tok/s」是**每个 turn 结束后**算出来的平均值，
// 看不到"此刻正在以多快生成"。本插件挂在 `llm/stream` waterfall 上包装下游流，
// 逐个 chunk 记录时间与累计 token，维护一个滑动窗口算出**实时**速度，
// 再由 `webServer` 暴露成一个小 JSON 给浏览器半边轮询。
//
// 数据流：
//   llm/stream waterfall ──包装──▶ 下游 chunk 流（原样透传，不改变模型可见内容）
//                              └─▶ 采样 (t, 累计token) ─▶ 3 秒滑动窗口 ─▶ GET /dsh-tokspeed/api/speed
//
// token 数是**估算**：文本用 CJK=1 字/token、ASCII≈4 字符/token 的启发式。
// provider 精确用量要等一次 step 结束才有，那样就不叫"实时"了。

export const name = 'dsh-token-speed'

// llm 服务必须先存在，我们监听的 waterfall 才是它注册的那个。
export const inject = ['llm']

/** 滑动窗口长度：用最近这么久的采样算速度。 */
const WINDOW_MS = 3000
/** 超过这么久没有新 chunk 就认为生成停了，速度归零。 */
const IDLE_MS = 1200

const state = {
  /** 滑动窗口采样：[{t, tokens}]，按时间递增。 */
  samples: [],
  /** 最近一次收到 chunk 的时间戳。 */
  lastChunkAt: 0,
  /** 本次生成累计的估算 token。 */
  runTokens: 0,
  /** 本次生成开始时间。 */
  runStartedAt: 0,
  /** 观测到的峰值速度，便于回看"刚才最快多少"。 */
  peakTps: 0,
}

/** 估算一段文本的 token 数（CJK 近似 1 字 1 token，ASCII 近似 4 字符 1 token）。 */
function approxTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  for (const ch of text) {
    if (ch.codePointAt(0) > 0x2e80) cjk += 1
  }
  const ascii = text.length - cjk
  return cjk + ascii / 4
}

/** 取一个 chunk 贡献的 token 数；只统计真正携带模型输出的增量类型。 */
function tokensOfChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return 0
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return approxTokens(chunk.text)
    case 'tool-call-delta':
      return approxTokens(chunk.arguments)
    default:
      return 0
  }
}

/** 记录一次采样并把窗口外的旧样本丢掉。 */
function pushSample(now, runTokens) {
  state.samples.push({ t: now, tokens: runTokens })
  const cut = now - WINDOW_MS
  while (state.samples.length > 2 && state.samples[0].t < cut) state.samples.shift()
  if (state.samples.length > 400) state.samples.splice(0, state.samples.length - 400)
}

/** 计算当前速度快照，供 HTTP 路由返回。 */
function snapshot() {
  const now = Date.now()
  const sinceChunk = state.lastChunkAt === 0 ? Infinity : now - state.lastChunkAt
  const active = sinceChunk <= IDLE_MS

  let tps = 0
  if (active) {
    const cut = now - WINDOW_MS
    const recent = state.samples.filter((s) => s.t >= cut)
    if (recent.length >= 2) {
      const first = recent[0]
      const last = recent[recent.length - 1]
      const dt = (last.t - first.t) / 1000
      if (dt > 0) tps = (last.tokens - first.tokens) / dt
    }
    if (tps > state.peakTps) state.peakTps = tps
  } else if (sinceChunk > WINDOW_MS * 2) {
    // 空闲够久，重置本轮统计
    state.samples.length = 0
    state.runTokens = 0
    state.runStartedAt = 0
    state.peakTps = 0
  }

  return {
    active,
    tps: Math.max(0, tps),
    peakTps: Math.max(0, state.peakTps),
    runTokens: Math.round(state.runTokens),
    runMs: state.runStartedAt === 0 ? 0 : now - state.runStartedAt,
    msSinceChunk: Number.isFinite(sinceChunk) ? Math.round(sinceChunk) : null,
  }
}

/** 解析 URL 的查询串（只认第一个 `?` 之后的部分）。 */
function queryOf(url) {
  const out = {}
  const text = typeof url === 'string' ? url : ''
  const at = text.indexOf('?')
  if (at < 0) return out
  for (const pair of text.slice(at + 1).split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))
    if (key === '') continue
    const raw = eq < 0 ? '' : pair.slice(eq + 1)
    try {
      out[key] = decodeURIComponent(raw)
    } catch (error) {
      out[key] = raw
    }
  }
  return out
}

/**
 * `snapshot()` 会 fold 整个会话日志，所以兜底路径必须限频 —— 否则 400ms 一次的
 * 浏览器轮询会把它变成常态操作。
 */
const FOLD_MIN_INTERVAL_MS = 3000
const foldState = { at: 0, id: '', value: null }

/**
 * 读一个会话的全量轮/步统计（`sessionStats` 投影）。
 *
 * 这条投影服务端是有的（web profile 挂了 dsh-session-stats），但它**不在**
 * 客户端可读投影的 schema 里（那份只有 tokenUsage/contextPressure/contextBreakdown 等），
 * 所以浏览器侧 `useProjection('sessionStats')` 永远拿不到值 —— 官方那条
 * `N 轮 M 步` 因此恒不渲染。只能由 host 侧读出来、经本路由交给浏览器半边渲染。
 *
 * 全程用 ctx.get：Cordis 里访问未在 inject 声明的服务属性会让整棵插件树加载失败，
 * 而 get 拿不到只返回 undefined。
 *
 * @returns `{ value, diag }` —— diag 只记步骤名与键名，不含会话内容，便于重启后定位。
 */
function sessionStatsOf(ctx, sessionId) {
  const diag = { step: 'init' }
  try {
    if (typeof sessionId !== 'string' || sessionId === '') {
      diag.step = 'no-id'
      return { value: null, diag }
    }
    const sessions = ctx.get('sessions')
    if (sessions === null || sessions === undefined || typeof sessions.get !== 'function') {
      diag.step = 'no-sessions-service'
      return { value: null, diag }
    }
    const session = sessions.get(sessionId)
    if (session === null || session === undefined) {
      diag.step = 'no-such-session'
      return { value: null, diag }
    }
    const projections = ctx.get('sessionProjections')
    if (projections === null || projections === undefined) {
      diag.step = 'no-projections-service'
      return { value: null, diag }
    }

    // 1) 已物化的 cell：最快，正常运行时的路径。
    if (typeof projections.cachedSnapshot === 'function') {
      try {
        const snap = projections.cachedSnapshot(session)
        const value = snap === undefined ? undefined : snap.values?.sessionStats
        if (value !== undefined) {
          diag.step = 'cached'
          return { value, diag }
        }
        diag.cached = 'empty'
      } catch (error) {
        diag.cached = 'threw: ' + String(error)
      }
    }

    // 2) 兜底：完整 fold（遍历整个日志），按会话限频。
    const now = Date.now()
    if (foldState.id === sessionId && now - foldState.at < FOLD_MIN_INTERVAL_MS) {
      diag.step = 'fold-throttled'
      return { value: foldState.value, diag }
    }
    if (typeof projections.snapshot === 'function') {
      try {
        const snap = projections.snapshot(session)
        const value = snap === undefined ? undefined : snap.values?.sessionStats
        foldState.at = now
        foldState.id = sessionId
        foldState.value = value === undefined ? null : value
        diag.step = 'fold'
        return { value: foldState.value, diag }
      } catch (error) {
        diag.step = 'fold-threw'
        diag.message = String(error)
        return { value: null, diag }
      }
    }
    diag.step = 'no-snapshot-api'
    return { value: null, diag }
  } catch (error) {
    diag.step = 'error'
    diag.message = String(error)
    return { value: null, diag }
  }
}

/** 包装下游流：原样透传每个 chunk，顺便采样。 */
async function* traced(iterable) {
  const startedAt = Date.now()
  state.runTokens = 0
  state.runStartedAt = startedAt
  state.samples.length = 0
  state.peakTps = 0
  state.lastChunkAt = startedAt
  pushSample(startedAt, 0)

  let tokens = 0
  for await (const chunk of iterable) {
    const n = tokensOfChunk(chunk)
    if (n > 0) {
      tokens += n
      state.runTokens = tokens
      state.lastChunkAt = Date.now()
      pushSample(state.lastChunkAt, tokens)
    }
    yield chunk
  }
}

/** 挂载：包装 llm/stream，并暴露一个只读的 JSON 快照路由。 */
/**
 * 防重复注册：同一进程内路由只装一次。
 *
 * zh_pro 的热装卸监督器会对新出现的插件反复执行「热卸载 / 热挂载」，
 * 于是 apply() 会被调用多次。重复 webServer.register 同一路径会抛错，
 * 而错误一旦冒泡出去，整棵插件树加载失败、服务起不来——实测就是这么崩的。
 * 所以这里既做幂等，也把所有注册动作的异常就地吞掉。
 */
let routeInstalled = false

export function apply(ctx) {
  try {
    ctx.on('llm/stream', (options, next) => {
      let downstream
      try {
        downstream = next()
      } catch (error) {
        // 适配器派发失败照常抛给调用方
        throw error
      }
      if (downstream === null || downstream === undefined) return downstream
      if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream
      return traced(downstream)
    })
  } catch (error) {
    console.warn('[dsh-token-speed] 注册 llm/stream 监听失败（已忽略）：', error)
  }

  const install = () => {
    if (routeInstalled) return true
    try {
      const webServer = ctx.get('webServer')
      if (webServer === null || webServer === undefined) return false
      if (typeof webServer.register !== 'function') return false

      const disposer = webServer.register({
        kind: 'prefix',
        path: '/dsh-tokspeed/api',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
            return
          }
          // `/stats` 额外带上该会话的全量轮/步统计；其余路径维持原来的速度快照形状。
          const url = typeof req.url === 'string' ? req.url : ''
          let payload
          if (url.indexOf('/stats') >= 0) {
            const parsed = sessionStatsOf(ctx, queryOf(url).id)
            payload = { ok: true, ...snapshot(), stats: parsed.value, diag: parsed.diag }
          } else {
            payload = { ok: true, ...snapshot() }
          }
          const body = JSON.stringify(payload)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(req.method === 'HEAD' ? undefined : body)
        },
      })
      routeInstalled = true
      ctx.effect(() => {
        return () => {
          routeInstalled = false
          try {
            if (typeof disposer === 'function') disposer()
          } catch (error) {
            // 下行可能已先行拆除，忽略
          }
        }
      }, 'dsh-token-speed: /dsh-tokspeed/api route')
      // 用 console 而不是 ctx.logger：后者同样受 inject 约束，未声明一样会拖垮整棵树
      console.info('[dsh-token-speed] 实时速度路由已就绪：/dsh-tokspeed/api/speed')
      return true
    } catch (error) {
      // 注册失败只意味着没有这个读取接口，绝不能拖垮整棵树
      console.warn('[dsh-token-speed] 路由注册失败（已忽略）：', error)
      return true
    }
  }

  if (!install()) {
    // webServer 可能晚于本插件出现，等服务注册事件再装一次。
    //
    // 这里刻意不碰 ctx.off：Cordis 里访问 ctx 上的服务属性必须先在 inject 里声明，
    // 否则启动期就会以 "cannot get property off without inject" 让整棵插件树加载失败。
    // ctx.on 的监听本身是 fiber 作用域的，插件卸载时自动解绑。
    let done = false
    try {
      ctx.on('internal/service', (serviceName) => {
        if (done || serviceName !== 'webServer') return
        done = install()
      })
    } catch (error) {
      console.warn('[dsh-token-speed] 等待 webServer 失败（已忽略）：', error)
    }
  }
}

export { approxTokens, tokensOfChunk, snapshot }

export default { name, inject, apply }
