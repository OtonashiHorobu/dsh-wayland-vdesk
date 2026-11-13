import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { AudioBridge } from './audio.js'
import { caps, parentRuntimeDir } from './config.js'
import { execFileP, freePort, killTree, sleep, spawnLogged, tcpOpen, waitUntil } from './util.js'

const BUTTONS = { left: 1, middle: 2, right: 3 }
const SCROLL = { up: 4, down: 5, left: 6, right: 7 }

/** Aliases for common keys, mapped to XKB keysym names understood by wtype. */
const KEY_ALIASES = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  super: 'super',
  meta: 'super',
  win: 'super',
}

const MODIFIER_KEYSYMS = new Set(['ctrl', 'shift', 'alt', 'super'])

function parseCombo(combo) {
  const parts = String(combo)
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  const key = parts.pop() ?? ''
  const modifiers = parts.map((mod) => KEY_ALIASES[mod.toLowerCase()] ?? mod.toLowerCase())
  for (const mod of modifiers) {
    if (!MODIFIER_KEYSYMS.has(mod)) throw new Error(`unknown modifier: ${mod}`)
  }
  const keysym = KEY_ALIASES[key.toLowerCase()] ?? (key.length === 1 ? key : key)
  return { modifiers, keysym }
}

/**
 * One off-screen desktop: a private headless sway compositor (Wayland + Xwayland),
 * a wayvnc server bound to loopback, and a private null audio sink.
 */
export class VDeskSession {
  constructor({ id, key, label, width, height, fps, quality, compression }) {
    this.id = id
    this.key = key ?? id
    this.label = label ?? id
    this.width = width ?? 1280
    this.height = height ?? 800
    this.fps = fps ?? 24
    this.quality = quality ?? 7
    this.compression = compression ?? 2
    this.output = 'HEADLESS-1'

    this.base = join(join(parentRuntimeDir, 'dsh-vdesk'), 'sessions', id)
    this.rtDir = join(this.base, 'run')
    this.logDir = join(this.base, 'log')
    this.shotDir = join(this.base, 'shots')
    this.envFile = join(this.base, 'env')

    this.procs = {}
    this.apps = []
    this.status = 'new'
    this.error = null
    this.createdAt = Date.now()
    this.lastActiveAt = Date.now()

    this.wlDisplay = null
    this.x11Display = null
    this.swaySock = null
    this.vncPort = null
    this.audio = new AudioBridge(this)
  }

  envForApps(extra = {}) {
    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: this.rtDir,
      XDG_SESSION_TYPE: 'wayland',
      XDG_CURRENT_DESKTOP: 'DSH-VDesk',
      WAYLAND_DISPLAY: this.wlDisplay,
      DISPLAY: this.x11Display ?? '',
      SWAYSOCK: this.swaySock ?? '',
      PULSE_SERVER: `unix:${join(parentRuntimeDir, 'pulse', 'native')}`,
      ...extra,
    }
    delete env.WAYLAND_SOCKET
    delete env.HYPRLAND_INSTANCE_SIGNATURE
    delete env.DESKTOP_STARTUP_ID
    delete env.XDG_ACTIVATION_TOKEN
    if (this.audio.sinkName) env.PULSE_SINK = this.audio.sinkName
    return env
  }

  /** Env for a tool that must talk to *this* compositor (swaymsg, grim, wtype...). */
  toolEnv() {
    return {
      ...process.env,
      XDG_RUNTIME_DIR: this.rtDir,
      WAYLAND_DISPLAY: this.wlDisplay,
      SWAYSOCK: this.swaySock ?? '',
      DISPLAY: this.x11Display ?? '',
    }
  }

  async start() {
    this.status = 'starting'
    await fsp.rm(this.base, { recursive: true, force: true })
    await fsp.mkdir(this.rtDir, { recursive: true, mode: 0o700 })
    await fsp.mkdir(this.logDir, { recursive: true })
    await fsp.mkdir(this.shotDir, { recursive: true })

    await this.writeSwayConfig()
    this.spawnSway()
    this.wlDisplay = await this.waitForWaylandDisplay()
    this.swaySock = await this.findSwaySocket()
    this.x11Display = await this.readX11Display()

    this.vncPort = await freePort()
    this.spawnWayvnc()
    await waitUntil(() => tcpOpen(this.vncPort), { timeout: 10_000, label: 'wayvnc port' })

    await this.audio.start()
    this.status = 'ready'
    this.touch()
    return this
  }

  async writeSwayConfig() {
    const lines = [
      `output ${this.output} resolution ${this.width}x${this.height}`,
      'xwayland enable',
      'default_border pixel 1',
      'default_floating_border pixel 1',
      'focus_follows_mouse yes',
      'mouse_warping none',
      'workspace 1 output ' + this.output,
      `exec_always --no-startup-id sh -c 'env > "${this.envFile}"'`,
    ]
    if (caps.swaybg) {
      lines.push(`exec_always --no-startup-id swaybg -c '#14161c'`)
    }
    await fsp.writeFile(join(this.base, 'sway.conf'), lines.join('\n') + '\n')
  }

  spawnSway() {
    const child = spawnLogged(caps.sway, ['-c', join(this.base, 'sway.conf')], {
      logPath: join(this.logDir, 'sway.log'),
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: this.rtDir,
        XDG_SESSION_TYPE: 'wayland',
        WLR_BACKENDS: 'headless',
        WLR_LIBINPUT_NO_DEVICES: '1',
        WLR_HEADLESS_OUTPUTS: '1',
        WLR_RENDERER_ALLOW_SOFTWARE: '1',
        XDG_CURRENT_DESKTOP: 'DSH-VDesk',
      },
    })
    this.procs.sway = child.pid
  }

  async waitForWaylandDisplay() {
    const entry = await waitUntil(
      async () => {
        const names = await fsp.readdir(this.rtDir).catch(() => [])
        return names.find((name) => name.startsWith('wayland-') && !name.endsWith('.lock')) ?? null
      },
      { timeout: 15_000, label: 'sway wayland socket' },
    )
    return entry
  }

  async findSwaySocket() {
    const names = await fsp.readdir(this.rtDir).catch(() => [])
    const sock = names.find((name) => name.startsWith('sway-ipc.') && name.endsWith('.sock'))
    return sock ? join(this.rtDir, sock) : null
  }

  async readX11Display() {
    const envText = await waitUntil(
      async () => {
        const text = await fsp.readFile(this.envFile, 'utf8').catch(() => '')
        return text.includes('DISPLAY=') ? text : null
      },
      { timeout: 10_000, label: 'xwayland display' },
    )
    const match = envText.match(/^DISPLAY=(.+)$/m)
    return match ? match[1].trim() : null
  }

  spawnWayvnc() {
    const args = [
      '-o', this.output,
      '-f', String(this.fps),
      '-r',
      '-n', `DSH ${this.label}`.slice(0, 60),
      '127.0.0.1',
      String(this.vncPort),
    ]
    const child = spawnLogged(caps.wayvnc, args, {
      logPath: join(this.logDir, 'wayvnc.log'),
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: this.rtDir,
        WAYLAND_DISPLAY: this.wlDisplay,
      },
    })
    this.procs.wayvnc = child.pid
  }

  /** Launch a program inside the desktop. Returns { pid, command, log }. */
  async run({ command, args, cwd, env, shell, wait, timeoutMs } = {}) {
    this.assertReady()
    if (!command) throw new Error('command is required')
    const index = this.apps.length + 1
    const logPath = join(this.logDir, `app-${String(index).padStart(2, '0')}.log`)
    const mergedEnv = this.envForApps(env ?? {})
    const useShell = shell ?? !args
    const finalCommand = useShell ? '/bin/sh' : command
    const finalArgs = useShell ? ['-c', args ? [command, ...args].join(' ') : command] : args ?? []
    const label = useShell ? (args ? [command, ...args].join(' ') : command) : [command, ...(args ?? [])].join(' ')

    if (wait) {
      return await this.runWait({ finalCommand, finalArgs, cwd, env: mergedEnv, label, timeoutMs })
    }

    const child = spawnLogged(finalCommand, finalArgs, {
      cwd: cwd ?? process.env.HOME,
      logPath,
      env: mergedEnv,
    })
    const entry = {
      pid: child.pid,
      command: label,
      log: logPath,
      startedAt: Date.now(),
    }
    this.apps.push(entry)
    this.touch()
    return entry
  }

  /** Run to completion with bounded captured output; kills the group on timeout. */
  async runWait({ finalCommand, finalArgs, cwd, env, label, timeoutMs = 30_000 }) {
    const limit = 64 * 1024
    const cap = (chunks, chunk) => {
      const size = chunks.reduce((sum, item) => sum + item.length, 0)
      if (size < limit) chunks.push(chunk)
    }
    const child = spawn(finalCommand, finalArgs, {
      cwd: cwd ?? process.env.HOME,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.apps.push({ pid: child.pid, command: label, log: null, startedAt: Date.now() })
    this.touch()

    const out = []
    const err = []
    child.stdout.on('data', (chunk) => cap(out, chunk))
    child.stderr.on('data', (chunk) => cap(err, chunk))

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid, 'SIGTERM')
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 1500).unref?.()
    }, Math.max(500, Number(timeoutMs) || 30_000))
    timer.unref?.()

    const code = await new Promise((resolve) => {
      child.on('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 124 : 0)))
      child.on('error', () => resolve(127))
    })
    clearTimeout(timer)
    return {
      pid: child.pid,
      command: label,
      exitCode: timedOut ? 124 : code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      timedOut,
    }
  }

  async shot({ region, maxWidth, format = 'png' } = {}) {
    this.assertReady()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const raw = join(this.shotDir, `shot-${stamp}.${format}`)
    const args = ['-t', format]
    if (region) args.push('-g', region)
    args.push(raw)
    const shot = await execFileP(caps.grim, args, { env: this.toolEnv() })
    if (shot.code !== 0) throw new Error(`grim failed: ${shot.stderr.trim() || shot.code}`)

    let out = raw
    if (maxWidth && caps.ffmpeg) {
      const scaled = join(this.shotDir, `shot-${stamp}-${maxWidth}.${format}`)
      const res = await execFileP(
        caps.ffmpeg,
        ['-y', '-loglevel', 'error', '-i', raw, '-vf', `scale=${maxWidth}:-1`, scaled],
        { env: this.toolEnv() },
      )
      if (res.code === 0) {
        out = scaled
        await fsp.rm(raw, { force: true })
      }
    }
    this.touch()
    return { path: out, width: this.width, height: this.height }
  }

  async windows() {
    this.assertReady()
    const res = await execFileP(caps.swaymsg, ['-t', 'get_tree'], { env: this.toolEnv() })
    if (res.code !== 0) throw new Error(`swaymsg failed: ${res.stderr.trim()}`)
    const tree = JSON.parse(res.stdout)
    const out = []
    const walk = (node) => {
      if (!node) return
      if (node.type === 'con' || node.type === 'floating_con') {
        if (node.pid) {
          out.push({
            id: node.id,
            pid: node.pid,
            title: node.name ?? '',
            appId: node.app_id ?? node.window_properties?.class ?? null,
            x11: Boolean(node.window_properties?.class),
            focused: Boolean(node.focused),
            rect: node.rect,
          })
        }
        for (const child of node.nodes ?? []) walk(child)
        for (const child of node.floating_nodes ?? []) walk(child)
      } else {
        for (const child of node.nodes ?? []) walk(child)
        for (const child of node.floating_nodes ?? []) walk(child)
      }
    }
    walk(tree)
    return out
  }

  async resize({ width, height }) {
    this.assertReady()
    const res = await execFileP(
      caps.swaymsg,
      ['output', this.output, 'resolution', `${width}x${height}`],
      { env: this.toolEnv() },
    )
    if (res.code !== 0) throw new Error(`resize failed: ${res.stderr.trim()}`)
    this.width = width
    this.height = height
    this.touch()
    return { width, height }
  }

  async input(actions = []) {
    this.assertReady()
    const results = []
    for (const action of actions) {
      results.push(await this.inputOne(action))
    }
    this.touch()
    return results
  }

  async inputOne(action = {}) {
    const type = action.type
    switch (type) {
      case 'move': {
        await this.swayCmd(`seat - cursor set ${Math.round(action.x)} ${Math.round(action.y)}`)
        return { type, ok: true }
      }
      case 'click': {
        const button = BUTTONS[action.button ?? 'left'] ?? 1
        await this.swayCmd(`seat - cursor set ${Math.round(action.x)} ${Math.round(action.y)}`)
        await sleep(action.delay ?? 25)
        await this.swayCmd(`seat - cursor press button${button}`)
        await sleep(action.hold ?? 40)
        await this.swayCmd(`seat - cursor release button${button}`)
        return { type, ok: true, x: action.x, y: action.y }
      }
      case 'down':
        await this.swayCmd(`seat - cursor press button${BUTTONS[action.button ?? 'left'] ?? 1}`)
        return { type, ok: true }
      case 'up':
        await this.swayCmd(`seat - cursor release button${BUTTONS[action.button ?? 'left'] ?? 1}`)
        return { type, ok: true }
      case 'drag': {
        const button = BUTTONS[action.button ?? 'left'] ?? 1
        await this.swayCmd(`seat - cursor set ${Math.round(action.from[0])} ${Math.round(action.from[1])}`)
        await this.swayCmd(`seat - cursor press button${button}`)
        const steps = action.steps ?? 12
        for (let i = 1; i <= steps; i += 1) {
          const x = action.from[0] + ((action.to[0] - action.from[0]) * i) / steps
          const y = action.from[1] + ((action.to[1] - action.from[1]) * i) / steps
          await this.swayCmd(`seat - cursor set ${Math.round(x)} ${Math.round(y)}`)
          await sleep(action.delay ?? 20)
        }
        await this.swayCmd(`seat - cursor release button${button}`)
        return { type, ok: true }
      }
      case 'scroll': {
        const direction = action.direction ?? 'down'
        const button = SCROLL[direction] ?? 5
        const times = Math.round(action.amount ?? 1)
        await this.swayCmd(`seat - cursor set ${Math.round(action.x ?? 0)} ${Math.round(action.y ?? 0)}`)
        for (let i = 0; i < Math.max(1, Math.abs(times)); i += 1) {
          await this.swayCmd(`seat - cursor press button${button}`)
          await this.swayCmd(`seat - cursor release button${button}`)
          await sleep(action.delay ?? 15)
        }
        return { type, ok: true }
      }
      case 'type': {
        const text = String(action.text ?? '')
        if (!text) return { type, ok: true, skipped: true }
        if (action.method === 'paste' || (action.method !== 'wtype' && caps.wlCopy && [...text].length > 40)) {
          await this.paste(text)
          return { type, ok: true, method: 'paste' }
        }
        const res = await execFileP(caps.wtype, ['-d', String(action.delay ?? 20), text], { env: this.toolEnv() })
        if (res.code !== 0) throw new Error(`wtype failed: ${res.stderr.trim()}`)
        return { type, ok: true, method: 'wtype' }
      }
      case 'key': {
        const combo = action.combo ?? action.key
        if (!combo) throw new Error('key action requires combo')
        const { modifiers, keysym } = parseCombo(combo)
        const args = []
        for (const mod of modifiers) args.push('-M', mod)
        args.push('-k', keysym)
        for (const mod of [...modifiers].reverse()) args.push('-m', mod)
        const res = await execFileP(caps.wtype, args, { env: this.toolEnv() })
        if (res.code !== 0) throw new Error(`wtype failed: ${res.stderr.trim()}`)
        return { type, ok: true, combo }
      }
      default:
        throw new Error(`unknown input action: ${type}`)
    }
  }

  async paste(text) {
    if (!caps.wlCopy) throw new Error('wl-copy not available for paste input')
    const env = this.toolEnv()
    const copy = spawn(caps.wlCopy, [], { env, stdio: ['pipe', 'ignore', 'ignore'] })
    copy.stdin.end(text)
    await new Promise((resolve, reject) => {
      copy.on('error', reject)
      copy.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`wl-copy exited ${code}`))))
    })
    await sleep(120)
    const res = await execFileP(caps.wtype, ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'], { env })
    if (res.code !== 0) throw new Error(`paste key failed: ${res.stderr.trim()}`)
  }

  async swayCmd(command) {
    const res = await execFileP(caps.swaymsg, ['--', command], { env: this.toolEnv() })
    if (res.code !== 0) throw new Error(`swaymsg "${command}" failed: ${res.stderr.trim()}`)
    return res.stdout
  }

  touch() {
    this.lastActiveAt = Date.now()
  }

  assertReady() {
    if (this.status !== 'ready') throw new Error(`session ${this.id} is ${this.status}`)
  }

  toJSON() {
    return {
      id: this.id,
      key: this.key,
      label: this.label,
      width: this.width,
      height: this.height,
      fps: this.fps,
      status: this.status,
      error: this.error,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      x11Display: this.x11Display,
      vncPort: this.vncPort,
      apps: this.apps,
      audio: { available: this.audio.available, sinkName: this.audio.sinkName },
      viewers: this.viewerCount ?? 0,
    }
  }

  async stop() {
    this.status = 'stopping'
    await this.audio.stop().catch(() => {})
    killTree(this.procs.wayvnc, 'SIGTERM')
    killTree(this.procs.sway, 'SIGTERM')
    await sleep(250)
    killTree(this.procs.wayvnc, 'SIGKILL')
    killTree(this.procs.sway, 'SIGKILL')
    this.status = 'stopped'
    await fsp.rm(this.base, { recursive: true, force: true }).catch(() => {})
  }
}
