#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import { HubClient, ensureDaemon } from './client.js'
import { DEFAULT_PORT } from './config.js'

const ENV_KEYS = ['XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'DISPLAY', 'SWAYSOCK', 'PULSE_SERVER', 'PULSE_SINK']

function usage() {
  console.log(`dsh-vdesk — off-screen virtual desktops for AI UI debugging

Usage: dsh-vdesk <command> [options]

Hub
  daemon                     run the hub in the foreground (Ctrl-C to stop)
  start                      start the hub in the background
  stop-hub                   stop the background hub and every desktop
  status [--json]            hub, capabilities and desktop summary

Desktops (KEY is a conversation key or a desktop id)
  list [--json]
  create [--conv KEY] [--size 1280x800] [--label NAME] [--fps 24]
  open [KEY]                 print the live-view URL
  env KEY [--json]           print shell exports that inject the desktop
  run KEY -- CMD [ARGS...]   launch a program inside the desktop
                             (--wait to collect output and exit code)
  exec KEY -- CMD [ARGS...]  run a program in the foreground with that env
  shot KEY [--out FILE] [--region X,Y,WxH] [--width N]
  input KEY [--json JSON]    raw input actions (or --stdin)
  click KEY X Y [--button left|right|middle] [--double]
  type KEY TEXT
  key KEY COMBO              e.g. ctrl+t, alt+F4, Return
  scroll KEY X Y up|down [N]
  look KEY DX DY             move the pointer relatively (mouse-look / games)
  windows KEY [--json]
  resize KEY 1600x900
  kill KEY | --all

Environment
  DSH_VDESK_PORT             hub port (default ${DEFAULT_PORT})
  DSH_VDESK_RUNTIME          runtime dir (default $XDG_RUNTIME_DIR/dsh-vdesk)
  DSH_VDESK_NOVNC            path to the noVNC web root
`)
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=')
      if (inline !== undefined) {
        flags[name] = inline
      } else if (['json', 'all', 'double', 'stdin', 'help', 'wait'].includes(name)) {
        flags[name] = true
      } else {
        flags[name] = argv[i + 1]
        i += 1
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function parseSize(text) {
  const match = String(text ?? '').match(/^(\d+)\s*[x×]\s*(\d+)$/)
  if (!match) throw new Error(`invalid size "${text}", expected 1280x800`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

async function target(client, key, { size, label, fps } = {}) {
  if (!key) throw new Error('a conversation key or desktop id is required')
  const res = await client.ensureSession({ key, ...(size ?? {}), label, fps })
  if (size) {
    const s = res.session
    if (s.width !== size.width || s.height !== size.height) {
      await client.resize(s.id, size.width, size.height)
    }
  }
  return res
}

async function main() {
  const argv = process.argv.slice(2)
  const { positional, flags } = parseArgs(argv)
  const command = positional[0]

  if (!command || flags.help || command === 'help') {
    usage()
    return
  }

  if (command === 'daemon') {
    await import('./daemon.js')
    return
  }

  if (command === 'start') {
    const state = await ensureDaemon()
    console.log(`hub: http://127.0.0.1:${state.port}`)
    return
  }

  const client = await HubClient.connect()

  if (command === 'stop-hub') {
    const list = await client.sessions()
    for (const session of list) await client.stop(session.id).catch(() => {})
    try {
      process.kill(client.state.pid, 'SIGTERM')
      console.log('hub stopped')
    } catch {
      console.log('hub was not running')
    }
    return
  }

  if (command === 'status') {
    const caps = await client.caps()
    const sessions = await client.sessions()
    if (flags.json) {
      console.log(JSON.stringify({ hub: client.state, caps, sessions }, null, 2))
      return
    }
    console.log(`hub      http://127.0.0.1:${client.state.port}  (pid ${client.state.pid})`)
    console.log(`caps     ${Object.entries(caps.caps).filter(([, v]) => v).map(([k]) => k).join(' ') || 'none'}`)
    console.log(`novnc    ${caps.novnc ? 'ok' : 'MISSING (install the novnc package)'}`)
    console.log(`desktops ${sessions.length}`)
    for (const s of sessions) {
      console.log(`  ${s.id}  ${s.label}  ${s.width}x${s.height}  ${s.status}  apps=${s.apps.length}`)
    }
    return
  }

  if (command === 'list') {
    const sessions = await client.sessions()
    if (flags.json) return console.log(JSON.stringify(sessions, null, 2))
    if (!sessions.length) return console.log('(no desktops)')
    for (const s of sessions) {
      console.log(`${s.id}  ${s.label}  ${s.width}x${s.height}  ${s.status}  apps=${s.apps.length}  ${s.x11Display ?? ''}`)
    }
    return
  }

  if (command === 'create') {
    const key = flags.conv ?? positional[1] ?? 'default'
    const size = flags.size ? parseSize(flags.size) : undefined
    const fallbackLabel = String(key).startsWith('session-') ? `对话 ${String(key).slice(8, 16)}` : String(key).slice(0, 24)
    const res = await client.ensureSession({
      key,
      label: flags.label ?? fallbackLabel,
      fps: flags.fps ? Number(flags.fps) : undefined,
      ...(size ?? {}),
    })
    if (size && (res.session.width !== size.width || res.session.height !== size.height)) {
      await client.resize(res.session.id, size.width, size.height)
    }
    console.log(`${res.session.id}  ${res.session.label}  ${size ? `${size.width}x${size.height}` : `${res.session.width}x${res.session.height}`}`)
    console.log(res.url)
    return
  }

  if (command === 'open') {
    const res = await target(client, positional[1] ?? flags.conv ?? 'default')
    console.log(client.pageUrl(res.session))
    return
  }

  if (command === 'env') {
    const res = await target(client, positional[1] ?? flags.conv ?? 'default')
    const env = await client.env(res.session.id)
    if (flags.json) return console.log(JSON.stringify(env, null, 2))
    for (const key of ENV_KEYS) {
      if (env[key] != null) console.log(`export ${key}='${env[key]}'`)
    }
    return
  }

  if (command === 'run' || command === 'exec') {
    const key = positional[1]
    if (!key) throw new Error('usage: dsh-vdesk run KEY -- CMD [ARGS...]')
    const cmd = positional.slice(2)
    if (!cmd.length) throw new Error('no command given (use -- before the command)')
    const res = await target(client, key)
    if (command === 'exec') {
      const env = await client.env(res.session.id)
      await new Promise((resolve) => {
        const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, ...env } })
        child.on('close', (code) => {
          process.exitCode = code ?? 0
          resolve()
        })
      })
      return
    }
    const wait = Boolean(flags.wait)
    const out = await client.run(res.session.id, {
      command: cmd[0],
      args: cmd.slice(1),
      wait,
      timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    })
    const app = out.app
    if (!wait) {
      console.log(`started pid ${app.pid}: ${app.command}`)
      if (app.log) console.log(`log: ${app.log}`)
      return
    }
    if (app.stdout) process.stdout.write(app.stdout)
    if (app.stderr) process.stderr.write(app.stderr)
    if (app.timedOut) console.error('(timed out)')
    process.exitCode = typeof app.exitCode === 'number' ? app.exitCode : 0
    return
  }

  if (command === 'shot') {
    const res = await target(client, positional[1] ?? flags.conv ?? 'default')
    const out = flags.out ?? `vdesk-${res.session.id}-${Date.now()}.png`
    const buf = await client.shotBuffer(res.session.id, {
      region: flags.region,
      maxWidth: flags.width ? Number(flags.width) : undefined,
    })
    await fsp.writeFile(out, buf)
    console.log(out)
    return
  }

  if (command === 'input') {
    const res = await target(client, positional[1] ?? flags.conv ?? 'default')
    let actions
    if (flags.stdin) {
      actions = JSON.parse(await new Promise((resolve) => {
        let text = ''
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', (chunk) => (text += chunk))
        process.stdin.on('end', () => resolve(text))
      }))
    } else {
      actions = JSON.parse(flags.json === true ? positional[2] : flags.json)
    }
    const out = await client.input(res.session.id, actions)
    console.log(JSON.stringify(out, null, 2))
    return
  }

  if (command === 'click') {
    const res = await target(client, positional[1])
    const x = Number(positional[2])
    const y = Number(positional[3])
    const button = flags.button ?? 'left'
    const actions = flags.double
      ? [{ type: 'click', x, y, button }, { type: 'click', x, y, button }]
      : [{ type: 'click', x, y, button }]
    await client.input(res.session.id, actions)
    console.log(`clicked ${button} at ${x},${y}`)
    return
  }

  if (command === 'scroll') {
    const res = await target(client, positional[1])
    const x = Number(positional[2])
    const y = Number(positional[3])
    const direction = positional[4] ?? 'down'
    const amount = Number(positional[5] ?? 3)
    await client.input(res.session.id, [{ type: 'scroll', x, y, direction, amount }])
    return
  }

  if (command === 'look') {
    const res = await target(client, positional[1])
    const dx = Number(positional[2] ?? 0)
    const dy = Number(positional[3] ?? 0)
    await client.input(res.session.id, [{ type: 'look', dx, dy }])
    console.log(`looked ${dx},${dy}`)
    return
  }

  if (command === 'type') {
    const res = await target(client, positional[1])
    const text = positional.slice(2).join(' ')
    await client.input(res.session.id, [{ type: 'type', text }])
    console.log(`typed ${text.length} chars`)
    return
  }

  if (command === 'key') {
    const res = await target(client, positional[1])
    const combo = positional[2]
    await client.input(res.session.id, [{ type: 'key', combo }])
    console.log(`sent ${combo}`)
    return
  }

  if (command === 'windows') {
    const res = await target(client, positional[1] ?? flags.conv ?? 'default')
    const windows = await client.windows(res.session.id)
    if (flags.json) return console.log(JSON.stringify(windows, null, 2))
    if (!windows.length) return console.log('(no windows)')
    for (const w of windows) {
      console.log(`${w.focused ? '*' : ' '} ${w.appId ?? '-'}  "${w.title}"  ${w.rect.width}x${w.rect.height}+${w.rect.x}+${w.rect.y}`)
    }
    return
  }

  if (command === 'resize') {
    const res = await target(client, positional[1])
    const size = parseSize(positional[2])
    await client.resize(res.session.id, size.width, size.height)
    console.log(`${size.width}x${size.height}`)
    return
  }

  if (command === 'kill') {
    if (flags.all) {
      const list = await client.sessions()
      for (const session of list) await client.stop(session.id)
      console.log(`stopped ${list.length} desktop(s)`)
      return
    }
    const key = positional[1]
    if (!key) throw new Error('usage: dsh-vdesk kill KEY | --all')
    // Never create a desktop just to stop it: resolve the existing one first.
    const sessions = await client.sessions()
    const found = sessions.find((session) => session.id === key || session.key === key)
    if (!found) throw new Error(`no such desktop: ${key}`)
    await client.stop(found.id)
    console.log(`stopped ${found.id}`)
    return
  }

  usage()
  process.exitCode = 1
}

main().catch((error) => {
  console.error(`dsh-vdesk: ${error.message}`)
  process.exitCode = 1
})
