import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { pkgRoot, pidFile, stateFile } from './config.js'
import { sleep } from './util.js'

export async function readState() {
  const text = await fsp.readFile(stateFile, 'utf8').catch(() => null)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function ping(state) {
  if (!state) return false
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/ping?token=${state.token}`, {
      signal: AbortSignal.timeout(700),
    })
    return res.ok && (await res.json()).ok === true
  } catch {
    return false
  }
}

/** Start the daemon in the background if it is not already answering. */
export async function ensureDaemon({ logPath } = {}) {
  const state = await readState()
  if (state && (await ping(state))) return state

  const log = logPath ?? join(pkgRoot, 'daemon.log')
  const out = await fsp.open(log, 'a').catch(() => null)
  const child = spawn(process.execPath, [join(pkgRoot, 'src/daemon.js')], {
    detached: true,
    stdio: out ? ['ignore', out.fd, out.fd] : 'ignore',
    env: process.env,
  })
  child.unref()
  if (out) await out.close().catch(() => {})

  for (let i = 0; i < 100; i += 1) {
    await sleep(100)
    const next = await readState()
    if (next && (await ping(next))) return next
  }
  throw new Error(`dsh-vdesk daemon did not start; see ${log}`)
}

export class HubClient {
  constructor(state) {
    this.state = state
  }

  static async connect() {
    const state = await ensureDaemon()
    return new HubClient(state)
  }

  url(path) {
    const sep = path.includes('?') ? '&' : '?'
    return `http://127.0.0.1:${this.state.port}${path}${sep}token=${this.state.token}`
  }

  async request(method, path, body, { raw = false } = {}) {
    const res = await fetch(this.url(path), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (raw) {
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    }
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text }
    }
    if (!res.ok) throw new Error(data.error ?? `${method} ${path} -> ${res.status}`)
    return data
  }

  async ensureSession(body) {
    return await this.request('POST', '/api/sessions', body)
  }

  async sessions() {
    return (await this.request('GET', '/api/sessions')).sessions
  }

  async session(id) {
    return (await this.request('GET', `/api/sessions/${encodeURIComponent(id)}`)).session
  }

  async run(id, body) {
    return await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/run`, body)
  }

  async shotBuffer(id, body = {}) {
    return await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/shot`, body, { raw: true })
  }

  async shotToFile(id, body, filePath) {
    const buf = await this.shotBuffer(id, body)
    await fsp.writeFile(filePath, buf)
    return filePath
  }

  async input(id, actions) {
    return await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/input`, { actions })
  }

  async resize(id, width, height) {
    return await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/resize`, { width, height })
  }

  async windows(id) {
    return (await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/windows`, {})).windows
  }

  async env(id) {
    return (await this.request('GET', `/api/sessions/${encodeURIComponent(id)}/env`)).env
  }

  async stop(id) {
    return await this.request('DELETE', `/api/sessions/${encodeURIComponent(id)}`)
  }

  async caps() {
    return await this.request('GET', '/api/caps')
  }

  pageUrl(session) {
    const params = new URLSearchParams({ token: this.state.token, conv: session.key })
    return `http://127.0.0.1:${this.state.port}/?${params.toString()}`
  }
}
