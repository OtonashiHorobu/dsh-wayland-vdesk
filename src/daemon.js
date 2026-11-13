#!/usr/bin/env node
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import net from 'node:net'
import { Hub } from './hub.js'
import { VDeskManager } from './manager.js'
import {
  checkRequirements,
  DEFAULT_PORT,
  describeCaps,
  HOST,
  pidFile,
  runtimeRoot,
  stateFile,
  tokenFile,
} from './config.js'
import { ensureDir, randomToken, sleep } from './util.js'

async function readToken() {
  const existing = await fsp.readFile(tokenFile, 'utf8').catch(() => '')
  const token = existing.trim() || randomToken()
  await fsp.writeFile(tokenFile, token, { mode: 0o600 })
  return token
}

async function pingPort(port, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping?token=${token}`, {
      signal: AbortSignal.timeout(800),
    })
    if (!res.ok) return false
    const body = await res.json()
    return Boolean(body.ok)
  } catch {
    return false
  }
}

function portFree(port) {
  return new Promise((resolvePort) => {
    const server = net.createServer()
    server.once('error', () => resolvePort(false))
    server.listen(port, HOST, () => server.close(() => resolvePort(true)))
  })
}

async function choosePort(preferred, token) {
  for (let port = preferred; port < preferred + 25; port += 1) {
    if (await pingPort(port, token)) return port // an existing daemon owns it
    if (await portFree(port)) return port
  }
  throw new Error(`no free port near ${preferred}`)
}

async function main() {
  const missing = checkRequirements()
  if (missing.length) {
    console.error(
      `dsh-vdesk needs these programs: ${[...new Set(missing)].join(', ')}\n` +
        'On Arch Linux: sudo pacman -S sway wayvnc grim wtype wl-clipboard',
    )
    process.exit(2)
  }

  await ensureDir(runtimeRoot, 0o700)
  const token = await readToken()

  const requested = Number(process.env.DSH_VDESK_PORT ?? DEFAULT_PORT)
  const port = process.env.DSH_VDESK_PORT_FIXED === '1' ? requested : await choosePort(requested, token)

  const manager = new VDeskManager()
  const hub = new Hub({ manager, token, port })
  await hub.listen()

  await fsp.writeFile(
    stateFile,
    JSON.stringify({ port, pid: process.pid, token, startedAt: Date.now(), origin: hub.origin }, null, 2),
    { mode: 0o600 },
  )
  await fsp.writeFile(pidFile, String(process.pid))

  console.log(`dsh-vdesk hub listening on ${hub.origin}`)
  console.log(`  caps: ${JSON.stringify(describeCaps())}`)
  if (!hub.novncRoot) console.warn('  warning: noVNC not found; the live view will not render')

  const shutdown = async (signal) => {
    console.log(`\n[${signal}] stopping ${manager.sessions.size} desktop(s)`)
    await manager.stopAll().catch(() => {})
    await hub.close().catch(() => {})
    await fsp.rm(stateFile, { force: true }).catch(() => {})
    await fsp.rm(pidFile, { force: true }).catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('uncaughtException', (error) => {
    console.error('uncaught', error)
  })

  // Keep the event loop alive even with no sessions.
  setInterval(() => {}, 1 << 30)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
