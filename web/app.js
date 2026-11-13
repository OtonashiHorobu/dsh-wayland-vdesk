const params = new URLSearchParams(location.search)
const TOKEN = params.get('token') ?? ''
const WANTED_KEY = params.get('conv') ?? ''
const EMBEDDED = params.get('embed') === '1'

const els = {
  select: document.getElementById('session-select'),
  meta: document.getElementById('meta'),
  stage: document.getElementById('stage'),
  screen: document.getElementById('screen'),
  hint: document.getElementById('hint'),
  conn: document.getElementById('conn'),
  connText: document.getElementById('conn-text'),
  caps: document.getElementById('caps'),
  audio: document.getElementById('audio-toggle'),
  volume: document.getElementById('volume'),
  fit: document.getElementById('fit-btn'),
  refresh: document.getElementById('refresh-btn'),
  full: document.getElementById('full-btn'),
}

const state = {
  sessions: [],
  current: null,
  rfb: null,
  audio: null,
  volume: 65,
  audioOn: false,
  reconnectTimer: null,
}

/* ---------------------------------------------------------------- theme */

function applyTheme(message) {
  if (!message || message.type !== 'dsh-theme') return
  const root = document.documentElement
  if (message.scheme === 'dark' || message.scheme === 'light') root.dataset.scheme = message.scheme
  if (message.font) root.style.setProperty('--vd-font', message.font)
  for (const [name, value] of Object.entries(message.tokens ?? {})) {
    if (name.startsWith('--dsw-') && typeof value === 'string' && value) root.style.setProperty(name, value)
  }
  if (state.rfb && message.tokens?.['--dsw-alias-bg-document-preview']) {
    state.rfb.background = message.tokens['--dsw-alias-bg-document-preview']
  }
}

window.addEventListener('message', (event) => applyTheme(event.data))
if (window.parent !== window) window.parent.postMessage({ type: 'vdesk-ready' }, '*')

function themeToken(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/* ------------------------------------------------------------------ api */

function api(path, options) {
  const url = new URL(path, location.origin)
  url.searchParams.set('token', TOKEN)
  return fetch(url, options).then(async (res) => {
    if (!res.ok) throw new Error(`${path} -> ${res.status}`)
    return res.json()
  })
}

function setConn(text, tone = '') {
  els.connText.textContent = text
  els.conn.classList.toggle('ok', tone === 'ok')
  els.conn.classList.toggle('bad', tone === 'error')
}

function showHint(text, action) {
  els.hint.innerHTML = ''
  if (text) {
    const label = document.createElement('div')
    label.textContent = text
    els.hint.append(label)
  }
  if (action) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'primary'
    button.textContent = action.label
    button.addEventListener('click', action.run)
    els.hint.append(button)
  }
  els.hint.classList.toggle('hidden', !text && !action)
}

/* ------------------------------------------------------------- sessions */

async function loadSessions() {
  const { sessions } = await api('/api/sessions')
  state.sessions = sessions
  els.select.innerHTML = ''
  for (const session of sessions) {
    const option = document.createElement('option')
    option.value = session.id
    option.textContent = `${session.label} · ${session.width}×${session.height}`
    els.select.append(option)
  }
  if (!sessions.length) {
    els.select.disabled = true
    showHint('这个对话还没有虚拟桌面，让 agent 调用 vdesk_create 就会出现在这里。')
    setConn('无桌面')
    return null
  }
  els.select.disabled = false
  const wanted = state.current?.id ?? sessions.find((s) => s.key === WANTED_KEY)?.id ?? sessions[0].id
  const next = sessions.find((s) => s.id === wanted) ?? sessions[0]
  els.select.value = next.id
  return next
}

function teardown() {
  clearTimeout(state.reconnectTimer)
  if (state.rfb) {
    try {
      state.rfb.disconnect()
    } catch {
      /* ignore */
    }
    state.rfb = null
  }
  disposeAudio()
}

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}?token=${encodeURIComponent(TOKEN)}`
}

async function connect(session) {
  teardown()
  state.current = session
  els.meta.textContent = `${session.width}×${session.height} · ${session.x11Display ?? '…'}`
  showHint('连接中…')
  setConn('连接中')

  let RFB
  try {
    ;({ default: RFB } = await import('./vendor/novnc/core/rfb.js'))
  } catch {
    showHint('noVNC 未安装：请安装 novnc 包，或用 DSH_VDESK_NOVNC 指向 noVNC 目录。')
    setConn('缺少 noVNC', 'error')
    return
  }

  const rfb = new RFB(els.screen, wsUrl(`/vnc/${session.id}`), {
    credentials: { password: '' },
    shared: true,
    wsProtocols: ['binary'],
  })
  rfb.scaleViewport = true
  rfb.resizeSession = false
  rfb.background = themeToken('--dsw-alias-bg-document-preview', '#ebeef2')
  rfb.addEventListener('connect', () => {
    showHint('')
    setConn('已连接', 'ok')
  })
  rfb.addEventListener('disconnect', (event) => {
    if (event.detail.clean) {
      setConn('已断开')
      showHint('连接已断开。')
    } else {
      setConn('连接中断', 'error')
      showHint('连接中断，正在重试…')
    }
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = setTimeout(() => {
      if (state.current?.id === session.id) connect(session)
    }, 1500)
  })
  rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: '' }))
  state.rfb = rfb
}

/* ---------------------------------------------------------------- audio */

class FloatRing {
  constructor() {
    this.chunks = []
    this.length = 0
  }

  push(chunk) {
    if (!chunk.length) return
    this.chunks.push(chunk)
    this.length += chunk.length
    while (this.length > 24_000 && this.chunks.length > 1) {
      this.length -= this.chunks.shift().length
    }
  }

  read(out) {
    const size = out.length
    if (this.length < size) {
      out.fill(0)
      return false
    }
    let written = 0
    while (written < size) {
      const head = this.chunks[0]
      const need = size - written
      if (head.length <= need) {
        out.set(head, written)
        written += head.length
        this.chunks.shift()
        this.length -= head.length
      } else {
        out.set(head.subarray(0, need), written)
        this.chunks[0] = head.subarray(need)
        this.length -= need
        written += need
      }
    }
    return true
  }
}

function ensureAudioGraph() {
  if (state.audio) return state.audio
  const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })
  const gain = ctx.createGain()
  gain.gain.value = state.volume / 100
  gain.connect(ctx.destination)

  const left = new FloatRing()
  const right = new FloatRing()
  const proc = ctx.createScriptProcessor(2048, 0, 2)
  proc.onaudioprocess = (event) => {
    left.read(event.outputBuffer.getChannelData(0))
    right.read(event.outputBuffer.getChannelData(1))
  }
  proc.connect(gain)
  state.audio = { ctx, gain, proc, left, right, ws: null }
  return state.audio
}

function disposeAudio() {
  const audio = state.audio
  if (!audio) return
  try {
    audio.ws?.close()
  } catch {
    /* ignore */
  }
  try {
    audio.proc.disconnect()
    audio.gain.disconnect()
    audio.ctx.close()
  } catch {
    /* ignore */
  }
  state.audio = null
  state.audioOn = false
  els.audio.classList.remove('on')
  els.volume.disabled = true
}

function startAudioStream() {
  const audio = ensureAudioGraph()
  audio.ctx.resume()
  if (audio.ws) return
  const session = state.current
  if (!session) return
  const ws = new WebSocket(wsUrl(`/audio/${session.id}`))
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') return
    const samples = new Int16Array(event.data)
    if (samples.length % 2 !== 0) return
    const frames = samples.length / 2
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i += 1) {
      left[i] = samples[i * 2] / 32768
      right[i] = samples[i * 2 + 1] / 32768
    }
    audio.left.push(left)
    audio.right.push(right)
  }
  ws.onclose = () => {
    if (state.audio) state.audio.ws = null
  }
  audio.ws = ws
}

function toggleAudio() {
  if (!state.current) return
  if (state.audioOn) {
    disposeAudio()
    return
  }
  ensureAudioGraph()
  startAudioStream()
  state.audioOn = true
  els.audio.classList.add('on')
  els.volume.disabled = false
}

/* --------------------------------------------------------------- wiring */

els.audio.addEventListener('click', toggleAudio)

els.volume.addEventListener('input', () => {
  state.volume = Number(els.volume.value)
  if (state.audio) state.audio.gain.gain.value = state.volume / 100
})

els.select.addEventListener('change', () => {
  const session = state.sessions.find((s) => s.id === els.select.value)
  if (!session) return
  const keepAudio = state.audioOn
  connect(session).then(() => {
    if (keepAudio) {
      state.audioOn = false
      toggleAudio()
    }
  })
})

els.refresh.addEventListener('click', () => {
  if (state.current) connect(state.current)
})

els.fit.addEventListener('click', () => {
  if (state.rfb) state.rfb.scaleViewport = !state.rfb.scaleViewport
})

els.full.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen()
  else els.stage.requestFullscreen?.()
})

async function boot() {
  if (EMBEDDED) document.body.classList.add('embed')
  if (!TOKEN) {
    showHint('缺少访问令牌：请从 DSH 面板或 CLI 打印的 URL 打开。')
    return
  }
  try {
    const caps = await api('/api/caps')
    els.caps.textContent = caps.novnc ? '' : 'noVNC 未安装'
  } catch {
    /* not fatal */
  }
  const session = await loadSessions()
  if (!session) return
  await connect(session)
  setInterval(() => {
    loadSessions().then(() => {
      if (!state.current) return
      const fresh = state.sessions.find((s) => s.id === state.current.id)
      if (fresh) {
        els.meta.textContent = `${fresh.width}×${fresh.height} · ${fresh.x11Display ?? '…'}`
      }
    })
  }, 5000)
}

boot().catch((error) => {
  showHint(`加载失败：${error.message}`)
  setConn('加载失败', 'error')
})
