import { closeSync, openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { caps } from './config.js'
import { execFileP, killTree, sleep } from './util.js'

const SAMPLE_RATE = 48_000
const CHANNELS = 2
const BYTES_PER_SAMPLE = 2
const FRAME_MS = 20
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS) / 1000 * CHANNELS * BYTES_PER_SAMPLE // 3840

/**
 * Audio for one desktop: a private null sink (nothing ever reaches the real
 * speakers) plus an on-demand `parec` capture of that sink's monitor.
 */
export class AudioBridge {
  constructor(session) {
    this.session = session
    this.available = Boolean(caps.pactl && caps.parec)
    this.sinkName = `dsh_vdesk_${String(session.id).replace(/[^a-zA-Z0-9_]/g, '_')}`
    this.moduleId = null
    this.proc = null
    this.clients = new Set()
    this.pending = Buffer.alloc(0)
    this.idleTimer = null
    this.sampleRate = SAMPLE_RATE
    this.channels = CHANNELS
    this.frameMs = FRAME_MS
  }

  get monitorDevice() {
    return `${this.sinkName}.monitor`
  }

  async start() {
    if (!this.available) return false
    const res = await execFileP(caps.pactl, [
      'load-module',
      'module-null-sink',
      `sink_name=${this.sinkName}`,
      `sink_properties=device.description=DSH-VDesk-${this.session.id}`,
      `rate=${SAMPLE_RATE}`,
      `channels=${CHANNELS}`,
    ])
    if (res.code !== 0) {
      this.available = false
      this.lastError = res.stderr.trim() || 'pactl load-module failed'
      return false
    }
    this.moduleId = Number(res.stdout.trim()) || null
    // Wait until the sink is actually visible so early app launches route correctly.
    for (let i = 0; i < 50; i += 1) {
      const list = await execFileP(caps.pactl, ['list', 'short', 'sinks'])
      if (list.stdout.includes(this.sinkName)) return true
      await sleep(40)
    }
    return true
  }

  async stop() {
    this.stopCapture()
    for (const ws of this.clients) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()
    if (this.moduleId != null) {
      await execFileP(caps.pactl, ['unload-module', String(this.moduleId)]).catch(() => {})
      this.moduleId = null
    }
  }

  addClient(ws) {
    if (!this.available) {
      ws.close(1011, 'audio unavailable')
      return
    }
    this.clients.add(ws)
    clearTimeout(this.idleTimer)
    this.startCapture()
    ws.on('close', () => this.removeClient(ws))
    ws.on('error', () => this.removeClient(ws))
    // Tell the viewer what the stream looks like before the first frame.
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'format', sampleRate: SAMPLE_RATE, channels: CHANNELS, frameMs: FRAME_MS }))
    }
  }

  removeClient(ws) {
    this.clients.delete(ws)
    if (this.clients.size === 0) {
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.stopCapture(), 8000)
    }
  }

  startCapture() {
    if (this.proc || !this.available) return
    const logFd = openSync(join(this.session.logDir, 'audio.log'), 'a')
    const proc = spawn(
      caps.parec,
      [
        '--device', this.monitorDevice,
        '--format', 's16le',
        '--rate', String(SAMPLE_RATE),
        '--channels', String(CHANNELS),
        '--latency-msec', '40',
        '--raw',
      ],
      // Deliberately the *parent* environment: parec must reach the real audio server.
      { stdio: ['ignore', 'pipe', logFd], env: process.env },
    )
    closeSync(logFd)
    this.proc = proc
    proc.stdout.on('data', (chunk) => this.onPcm(chunk))
    proc.on('close', () => {
      if (this.proc === proc) this.proc = null
    })
    proc.on('error', () => {
      if (this.proc === proc) this.proc = null
    })
  }

  stopCapture() {
    if (!this.proc) return
    killTree(this.proc.pid, 'SIGTERM')
    this.proc = null
    this.pending = Buffer.alloc(0)
  }

  onPcm(chunk) {
    if (this.clients.size === 0) return
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    while (this.pending.length >= FRAME_BYTES) {
      const frame = this.pending.subarray(0, FRAME_BYTES)
      this.pending = this.pending.subarray(FRAME_BYTES)
      for (const ws of this.clients) {
        // Drop frames for slow viewers instead of growing an unbounded queue.
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount > 512 * 1024) continue
        ws.send(frame, { binary: true })
      }
    }
  }
}
