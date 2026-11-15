import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { which } from './util.js'

export const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
export const webRoot = join(pkgRoot, 'web')

/** The user's real session runtime dir (never the per-desktop one). */
export const parentRuntimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`

export const runtimeRoot = process.env.DSH_VDESK_RUNTIME ?? join(parentRuntimeDir, 'dsh-vdesk')
export const sessionsRoot = join(runtimeRoot, 'sessions')
export const tokenFile = join(runtimeRoot, 'token')
export const pidFile = join(runtimeRoot, 'hub.pid')
export const stateFile = join(runtimeRoot, 'hub.json')

export const DEFAULT_PORT = Number(process.env.DSH_VDESK_PORT ?? 7317)
export const HOST = '127.0.0.1'

const NOVNC_CANDIDATES = [
  process.env.DSH_VDESK_NOVNC,
  '/usr/share/webapps/novnc',
  '/usr/share/novnc',
  '/usr/share/javascript/novnc',
  '/usr/local/share/novnc',
  join(pkgRoot, 'node_modules/@novnc/novnc'),
].filter(Boolean)

export function resolveNovncRoot() {
  for (const candidate of NOVNC_CANDIDATES) {
    if (existsSync(join(candidate, 'core/rfb.js'))) return candidate
  }
  return null
}

export const caps = {
  get sway() {
    return which('sway')
  },
  get swaymsg() {
    return which('swaymsg')
  },
  get wayvnc() {
    return which('wayvnc')
  },
  get grim() {
    return which('grim')
  },
  get wtype() {
    return which('wtype')
  },
  get xdotool() {
    return which('xdotool')
  },
  get wlrctl() {
    return which('wlrctl')
  },
  get wlCopy() {
    return which('wl-copy')
  },
  get swaybg() {
    return which('swaybg')
  },
  get pactl() {
    return which('pactl')
  },
  get parec() {
    return which('parec')
  },
  get ffmpeg() {
    return which('ffmpeg')
  },
  get novnc() {
    return resolveNovncRoot()
  },
}

/** Everything the daemon needs before it is allowed to start sessions. */
export function checkRequirements() {
  const missing = []
  if (!caps.sway) missing.push('sway')
  if (!caps.swaymsg) missing.push('sway')
  if (!caps.wayvnc) missing.push('wayvnc')
  if (!caps.grim) missing.push('grim')
  if (!caps.wtype) missing.push('wtype')
  return missing
}

export function describeCaps() {
  return {
    sway: caps.sway,
    wayvnc: caps.wayvnc,
    grim: caps.grim,
    wtype: caps.wtype,
    xdotool: caps.xdotool,
    wlrctl: caps.wlrctl,
    wlCopy: caps.wlCopy,
    pactl: caps.pactl,
    parec: caps.parec,
    ffmpeg: caps.ffmpeg,
    novnc: caps.novnc,
    audio: Boolean(caps.pactl && caps.parec),
    x11: Boolean(caps.xdotool),
  }
}
