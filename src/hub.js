import http from 'node:http'
import net from 'node:net'
import fsp from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import { caps, HOST, resolveNovncRoot, webRoot } from './config.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

const MAX_BODY = 2 * 1024 * 1024

function safeJoin(root, pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  const full = resolve(root, `.${clean.startsWith('/') ? clean : `/${clean}`}`)
  if (!full.startsWith(resolve(root) + sep) && full !== resolve(root)) return null
  return full
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolveBody({})
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * The hub: one loopback HTTP+WebSocket server that serves the viewer page,
 * the JSON API, the noVNC assets, the VNC proxy and the PCM audio stream.
 */
export class Hub {
  constructor({ manager, token, port }) {
    this.manager = manager
    this.token = token
    this.port = port
    this.server = http.createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
    this.novncRoot = resolveNovncRoot()
  }

  get origin() {
    return `http://${HOST}:${this.port}`
  }

  urlFor(session, extra = {}) {
    const params = new URLSearchParams({ token: this.token, conv: session.key, ...extra })
    return `${this.origin}/?${params.toString()}`
  }

  listen() {
    return new Promise((resolveListen, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, HOST, () => resolveListen(this))
    })
  }

  async close() {
    this.wss.close()
    await new Promise((resolveClose) => this.server.close(resolveClose))
  }

  authorized(req, url) {
    const header = req.headers['x-vdesk-token']
    const query = url.searchParams.get('token')
    return header === this.token || query === this.token
  }

  async handleHttp(req, res) {
    const url = new URL(req.url, this.origin)
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!this.authorized(req, url)) return sendJson(res, 401, { error: 'bad token' })
        return await this.handleApi(req, res, url)
      }
      if (url.pathname.startsWith('/vendor/novnc/')) {
        if (!this.novncRoot) return sendJson(res, 404, { error: 'novnc not installed' })
        const rel = url.pathname.slice('/vendor/novnc/'.length)
        return await this.serveFile(res, this.novncRoot, rel)
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return await this.serveFile(res, webRoot, 'index.html')
      }
      return await this.serveFile(res, webRoot, url.pathname)
    } catch (error) {
      return sendJson(res, 500, { error: String(error.message ?? error) })
    }
  }

  async serveFile(res, root, relPath) {
    const full = safeJoin(root, relPath)
    if (!full) return sendJson(res, 403, { error: 'forbidden' })
    const stat = await fsp.stat(full).catch(() => null)
    if (!stat || !stat.isFile()) return sendJson(res, 404, { error: 'not found' })
    res.writeHead(200, {
      'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    })
    createReadStream(full).pipe(res)
  }

  async handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]
    const [, resource, id, action] = parts

    if (resource === 'ping') return sendJson(res, 200, { ok: true, pid: process.pid, port: this.port })
    if (resource === 'caps') return sendJson(res, 200, { caps: capsDescription(), novnc: Boolean(this.novncRoot) })
    if (resource === 'sessions' && !id) {
      if (req.method === 'GET') return sendJson(res, 200, { sessions: this.manager.list() })
      if (req.method === 'POST') {
        const body = await readBody(req)
        const session = await this.manager.ensure(body)
        return sendJson(res, 200, { session: session.toJSON(), url: this.urlFor(session) })
      }
    }
    if (resource === 'sessions' && id) {
      const session = this.manager.resolve(id)
      if (!session) return sendJson(res, 404, { error: `no such desktop: ${id}` })
      session.touch()

      if (!action && req.method === 'GET') {
        return sendJson(res, 200, { session: session.toJSON(), url: this.urlFor(session) })
      }
      if (action === 'env' && req.method === 'GET') {
        return sendJson(res, 200, { env: session.envForApps(), session: session.toJSON() })
      }
      if (!action && req.method === 'DELETE') {
        await this.manager.stop(session.id)
        return sendJson(res, 200, { ok: true })
      }
      if (action && req.method === 'POST') {
        const body = await readBody(req)
        switch (action) {
          case 'run': {
            const app = await session.run(body)
            return sendJson(res, 200, { app, session: session.toJSON() })
          }
          case 'shot': {
            const shot = await session.shot({ region: body.region, maxWidth: body.maxWidth })
            if (url.searchParams.get('meta') === '1') return sendJson(res, 200, shot)
            const buf = await fsp.readFile(shot.path)
            res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store' })
            return res.end(buf)
          }
          case 'input': {
            const results = await session.input(body.actions ?? [])
            return sendJson(res, 200, { results })
          }
          case 'resize': {
            const size = await session.resize({ width: Number(body.width), height: Number(body.height) })
            return sendJson(res, 200, { size })
          }
          case 'windows': {
            return sendJson(res, 200, { windows: await session.windows() })
          }
          case 'stop': {
            await this.manager.stop(session.id)
            return sendJson(res, 200, { ok: true })
          }
          case 'viewers': {
            session.viewers = Number(body.count) || 0
            return sendJson(res, 200, { ok: true })
          }
          default:
            return sendJson(res, 404, { error: `unknown action: ${action}` })
        }
      }
    }
    return sendJson(res, 404, { error: 'not found' })
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, this.origin)
    if (!this.authorized(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const parts = url.pathname.split('/').filter(Boolean) // ['vnc', id] | ['audio', id]
    const [kind, id] = parts
    const session = id ? this.manager.resolve(id) : null
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    if (kind === 'vnc') {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attachVnc(ws, session))
      return
    }
    if (kind === 'audio') {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        session.viewers = (session.viewers ?? 0) + 0
        session.audio.addClient(ws)
        ws.on('close', () => {})
      })
      return
    }
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
  }

  attachVnc(ws, session) {
    session.viewers = (session.viewers ?? 0) + 1
    session.touch()
    const tcp = net.connect({ port: session.vncPort, host: HOST })
    const closeBoth = () => {
      session.viewers = Math.max(0, (session.viewers ?? 1) - 1)
      try {
        tcp.destroy()
      } catch {
        /* ignore */
      }
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    tcp.on('data', (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data, { binary: true })
    })
    tcp.on('error', closeBoth)
    tcp.on('close', closeBoth)
    ws.on('message', (data) => {
      if (!tcp.destroyed) tcp.write(data)
    })
    ws.on('error', closeBoth)
    ws.on('close', closeBoth)
  }
}

function capsDescription() {
  return {
    sway: Boolean(caps.sway),
    wayvnc: Boolean(caps.wayvnc),
    grim: Boolean(caps.grim),
    wtype: Boolean(caps.wtype),
    xdotool: Boolean(caps.xdotool),
    wlCopy: Boolean(caps.wlCopy),
    pactl: Boolean(caps.pactl),
    parec: Boolean(caps.parec),
    ffmpeg: Boolean(caps.ffmpeg),
  }
}
