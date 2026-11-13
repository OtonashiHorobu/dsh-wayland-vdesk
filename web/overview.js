const params = new URLSearchParams(location.search)
const TOKEN = params.get('token') ?? ''

const els = {
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count'),
  refresh: document.getElementById('refresh-btn'),
  stopAll: document.getElementById('stop-all'),
}

const state = { sessions: [] }
const timers = new Map()

window.addEventListener('message', (event) => {
  const message = event.data
  if (!message || message.type !== 'dsh-theme') return
  const root = document.documentElement
  if (message.scheme === 'dark' || message.scheme === 'light') root.dataset.scheme = message.scheme
  if (message.font) root.style.setProperty('--vd-font', message.font)
  for (const [name, value] of Object.entries(message.tokens ?? {})) {
    if (name.startsWith('--dsw-') && typeof value === 'string' && value) root.style.setProperty(name, value)
  }
})
if (window.parent !== window) window.parent.postMessage({ type: 'vdesk-ready' }, '*')

function api(path, options) {
  const url = new URL(path, location.origin)
  url.searchParams.set('token', TOKEN)
  return fetch(url, options).then(async (res) => {
    if (!res.ok) throw new Error(`${path} -> ${res.status}`)
    return res.json()
  })
}

function viewerUrl(session) {
  const query = new URLSearchParams({ token: TOKEN, conv: session.key, from: 'overview' })
  return `/?${query.toString()}`
}

function frameUrl(session) {
  const query = new URLSearchParams({ token: TOKEN, w: '520', t: String(Date.now()) })
  return `/api/sessions/${encodeURIComponent(session.id)}/frame?${query.toString()}`
}

function formatAge(timestamp) {
  const delta = Math.max(0, Date.now() - Number(timestamp ?? Date.now()))
  const minutes = Math.round(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function card(session) {
  const article = document.createElement('article')
  article.className = 'card'
  article.dataset.id = session.id

  const link = document.createElement('a')
  link.className = 'thumb'
  link.href = viewerUrl(session)
  const img = document.createElement('img')
  img.alt = session.label
  img.loading = 'lazy'
  img.src = frameUrl(session)
  link.append(img)
  link.addEventListener('mouseenter', () => {
    img.src = frameUrl(session)
  })

  const body = document.createElement('div')
  body.className = 'card-body'
  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = session.label || session.id
  title.title = session.id
  const meta = document.createElement('div')
  meta.className = 'card-meta'
  meta.textContent = `${session.width}×${session.height} · ${session.apps?.length ?? 0} 个程序 · ${formatAge(session.lastActiveAt)}`
  body.append(title, meta)

  const actions = document.createElement('div')
  actions.className = 'card-actions'

  const open = document.createElement('a')
  open.className = 'btn'
  open.href = viewerUrl(session)
  open.textContent = '打开'

  const stop = document.createElement('button')
  stop.type = 'button'
  stop.className = 'btn danger'
  stop.textContent = '停止'
  stop.addEventListener('click', async () => {
    stop.disabled = true
    stop.textContent = '停止中…'
    try {
      await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' })
      timers.delete(session.id)
      await load()
    } catch {
      stop.disabled = false
      stop.textContent = '停止'
    }
  })

  actions.append(open, stop)
  article.append(link, body, actions)
  return article
}

async function load() {
  const { sessions } = await api('/api/sessions')
  state.sessions = sessions
  els.count.textContent = sessions.length ? `${sessions.length} 个` : ''
  els.grid.innerHTML = ''
  els.grid.classList.toggle('hidden', sessions.length === 0)
  els.empty.classList.toggle('hidden', sessions.length !== 0)
  els.empty.textContent = '还没有虚拟桌面。让 agent 调用 vdesk_create 就会出现在这里。'
  for (const session of sessions) els.grid.append(card(session))
  for (const [id, timer] of timers) {
    if (!sessions.some((s) => s.id === id)) {
      clearInterval(timer)
      timers.delete(id)
    }
  }
}

function startThumbnailRefresh() {
  setInterval(() => {
    for (const session of state.sessions) {
      const article = els.grid.querySelector(`.card[data-id="${session.id}"]`)
      const img = article?.querySelector('img')
      if (img) img.src = frameUrl(session)
    }
  }, 5000)
}

els.refresh.addEventListener('click', () => load())
els.stopAll.addEventListener('click', async () => {
  if (!state.sessions.length) return
  if (!window.confirm(`停止全部 ${state.sessions.length} 个虚拟桌面？`)) return
  els.stopAll.disabled = true
  for (const session of state.sessions) {
    await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }).catch(() => {})
  }
  els.stopAll.disabled = false
  await load()
})

if (!TOKEN) {
  els.empty.textContent = '缺少访问令牌：请从 DSH 面板打开。'
  els.empty.classList.remove('hidden')
} else {
  load().catch((error) => {
    els.empty.textContent = `加载失败：${error.message}`
    els.empty.classList.remove('hidden')
  })
  startThumbnailRefresh()
}
