import { VDeskSession } from './session.js'
import { shortHash } from './util.js'

const DEFAULT_WIDTH = Number(process.env.DSH_VDESK_WIDTH ?? 1280)
const DEFAULT_HEIGHT = Number(process.env.DSH_VDESK_HEIGHT ?? 800)
const MAX_IDLE_MS = Number(process.env.DSH_VDESK_IDLE_MS ?? 4 * 60 * 60 * 1000)

/** Owns every virtual desktop in this daemon, one per conversation key. */
export class VDeskManager {
  constructor() {
    this.sessions = new Map()
    this.byKey = new Map()
    this.pending = new Map()
    this.gcTimer = setInterval(() => this.collectIdle(), 60_000)
    this.gcTimer.unref?.()
  }

  idFor(key) {
    return `s-${shortHash(key)}`
  }

  /** Create (or return) the desktop bound to a conversation key. */
  async ensure({ key = 'default', label, width, height, fps, quality, compression } = {}) {
    const existing = this.byKey.get(key)
    if (existing) {
      existing.touch()
      return existing
    }
    const inflight = this.pending.get(key)
    if (inflight) return inflight

    const promise = (async () => {
      const session = new VDeskSession({
        id: this.idFor(key),
        key,
        label: label ?? key,
        width: width ?? DEFAULT_WIDTH,
        height: height ?? DEFAULT_HEIGHT,
        fps,
        quality,
        compression,
      })
      this.sessions.set(session.id, session)
      this.byKey.set(key, session)
      try {
        await session.start()
        return session
      } catch (error) {
        session.error = error.message
        session.status = 'failed'
        this.sessions.delete(session.id)
        this.byKey.delete(key)
        throw error
      } finally {
        this.pending.delete(key)
      }
    })()

    this.pending.set(key, promise)
    return promise
  }

  resolve(keyOrId) {
    return this.sessions.get(keyOrId) ?? this.byKey.get(keyOrId) ?? null
  }

  require(keyOrId) {
    const session = this.resolve(keyOrId)
    if (!session) throw new Error(`no such desktop: ${keyOrId}`)
    return session
  }

  list() {
    return [...this.sessions.values()].map((session) => session.toJSON())
  }

  async stop(keyOrId) {
    const session = this.resolve(keyOrId)
    if (!session) return false
    this.sessions.delete(session.id)
    this.byKey.delete(session.key)
    await session.stop()
    return true
  }

  async stopAll() {
    clearInterval(this.gcTimer)
    await Promise.all([...this.sessions.values()].map((session) => session.stop().catch(() => {})))
    this.sessions.clear()
    this.byKey.clear()
  }

  collectIdle() {
    const now = Date.now()
    for (const session of [...this.sessions.values()]) {
      if (session.status !== 'ready') continue
      if (session.viewers > 0) continue
      if (now - session.lastActiveAt > MAX_IDLE_MS) {
        this.stop(session.id).catch(() => {})
      }
    }
  }
}
