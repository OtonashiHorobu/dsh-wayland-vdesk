import { accessSync, closeSync, constants as FS, openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import { delimiter, join } from 'node:path'
import { spawn } from 'node:child_process'

/** Resolve an executable from PATH without spawning `which`. */
export function which(bin, extraPaths = []) {
  if (bin.includes('/')) {
    try {
      accessSync(bin, FS.X_OK)
      return bin
    } catch {
      return null
    }
  }
  const dirs = [...extraPaths, ...(process.env.PATH ?? '').split(delimiter)]
  for (const dir of dirs) {
    if (!dir) continue
    const full = join(dir, bin)
    try {
      accessSync(full, FS.X_OK)
      return full
    } catch {
      /* keep looking */
    }
  }
  return null
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll `fn` until it returns a truthy value. */
export async function waitUntil(fn, { timeout = 10_000, interval = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let lastError
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
    }
    await sleep(interval)
  }
}

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export function tcpOpen(port, host = '127.0.0.1', timeout = 250) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** Run a command to completion and return its output. Never throws on exit code. */
export function execFileP(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error.message) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

export async function ensureDir(dir, mode = 0o755) {
  await mkdir(dir, { recursive: true, mode })
  return dir
}

export function randomToken(bytes = 16) {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return Buffer.from(buf).toString('hex')
}

export function shortHash(input) {
  let hash = 0x811c9dc5
  for (const char of String(input)) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7)
}

/** Kill a whole process group spawned with `detached: true`. */
export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}

export function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Spawn a long-lived process with stdout+stderr appended to `logPath`.
 * The fd is opened synchronously so the child gets a valid descriptor.
 */
export function spawnLogged(command, args, { cwd, env, logPath, detached = true } = {}) {
  const fd = openSync(logPath, 'a')
  try {
    const child = spawn(command, args, {
      cwd,
      env,
      detached,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
    return child
  } finally {
    closeSync(fd)
  }
}
