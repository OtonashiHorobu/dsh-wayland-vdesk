/**
 * Host half of dsh-vdesk: agent tools plus the authenticated browser route that
 * the Client view uses to learn where this conversation's desktop lives.
 *
 * Everything heavy (compositor, VNC, audio capture, HTTP hub) runs in a separate
 * long-lived daemon so that tools, CLI and the Web view share one desktop and a
 * DSH restart never leaves orphaned compositors behind.
 */
import { HubClient, ensureDaemon } from './src/client.js'
import { checkRequirements } from './src/config.js'

export const name = 'dsh-vdesk'

export const inject = ['tools', 'attachments', 'connection']

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

const MISSING_HINT =
  'Install the desktop stack first: sudo pacman -S sway wayvnc grim wtype wl-clipboard'

function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id
  if (id === undefined || id === null) {
    throw new Error('vdesk tools need an agent session (this call has no conversation)')
  }
  return String(id)
}

function assertTools() {
  const missing = checkRequirements()
  if (missing.length > 0) throw new Error(`vdesk cannot start: missing ${[...new Set(missing)].join(', ')}. ${MISSING_HINT}`)
}

export function apply(ctx, config = {}) {
  const width = Number(config.width ?? 1280)
  const height = Number(config.height ?? 800)
  const fps = Number(config.fps ?? 24)

  /** @type {Promise<HubClient> | undefined} */
  let connecting

  const hub = () => {
    connecting ??= ensureDaemon().then((state) => new HubClient(state))
    connecting.catch(() => {
      connecting = undefined
    })
    return connecting
  }

  const desktopOf = async (exec, size = {}) => {
    assertTools()
    const client = await hub()
    const key = sessionIdOf(exec)
    const title = String(exec?.agent?.session?.header?.title ?? '').trim()
    const short = key.replace(/^session-/, '').slice(0, 8)
    const res = await client.ensureSession({
      key,
      label: title || `对话 ${short}`,
      width: size.width ?? width,
      height: size.height ?? height,
      fps,
    })
    return { client, session: res.session, url: res.url }
  }

  const ensureFor = async (key) => {
    assertTools()
    const client = await hub()
    return await client.ensureSession({ key, width, height, fps })
  }

  ctx.effect(
    () => () => {
      // Desktops keep running (the panel may still be open); idle GC owns them.
      connecting = undefined
    },
    'vdesk: release hub handle',
  )

  ctx.tools.register({
    name: 'vdesk_create',
    description:
      'Open the off-screen virtual desktop bound to this conversation and return its id, size and live-view URL. '
      + 'The desktop is a private headless Wayland compositor with Xwayland: GUI programs started with vdesk_run never appear '
      + 'on the user\'s real desktop. Safe to call again — it reuses the existing desktop and only resizes it when width/height differ.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', description: 'Desktop width in pixels. Defaults to the plugin default (1280).' },
        height: { type: 'integer', description: 'Desktop height in pixels. Defaults to the plugin default (800).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'width', 'height', 'url', 'x11Display'],
        properties: {
          id: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          url: { type: 'string' },
          x11Display: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `virtual desktop ${value.id} is ready at ${value.width}x${value.height} (X11 display ${value.x11Display})\n`
          + `live view: ${value.url}`,
      }],
    },
    async execute(args, exec) {
      const { client, session } = await desktopOf(exec, args ?? {})
      if (args?.width || args?.height) {
        const w = Number(args.width ?? session.width)
        const h = Number(args.height ?? session.height)
        if (w !== session.width || h !== session.height) await client.resize(session.id, w, h)
      }
      const fresh = await client.session(session.id)
      return {
        id: fresh.id,
        width: fresh.width,
        height: fresh.height,
        url: client.pageUrl(fresh),
        x11Display: fresh.x11Display ?? '',
      }
    },
  })

  ctx.tools.register({
    name: 'vdesk_run',
    description:
      'Start a program inside this conversation\'s virtual desktop. Its DISPLAY/WAYLAND_DISPLAY/XDG_RUNTIME_DIR/PULSE_SINK point at the '
      + 'off-screen desktop, so windows, clipboard and audio stay there. Returns the pid and the log path by default; set wait=true to collect '
      + 'bounded stdout/stderr and the exit code instead (useful for scripts and build tools).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Program to run. With no args it is interpreted by /bin/sh -c, so pipes and redirections work.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments, when the command should be executed directly instead of through a shell.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the user home.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables for the program.' },
        wait: { type: 'boolean', description: 'Wait for the program to exit and return its output. Defaults to false. GUI programs should not use it.' },
        timeoutMs: { type: 'integer', description: 'With wait=true, kill the program after this many milliseconds. Defaults to 30000.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'command'],
        properties: {
          pid: { type: 'integer' },
          command: { type: 'string' },
          log: { type: 'string' },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          timedOut: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const lines = [`started pid ${value.pid}: ${value.command}`]
        if (value.log) lines.push(`log: ${value.log}`)
        if (value.exitCode !== undefined) {
          lines.push(`exit ${value.exitCode}${value.timedOut ? ' (timed out)' : ''}`)
          if (value.stdout) lines.push(`<stdout>\n${value.stdout}</stdout>`)
          if (value.stderr) lines.push(`<stderr>\n${value.stderr}</stderr>`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const { client, session } = await desktopOf(exec)
      const command = String(args?.command ?? '').trim()
      if (!command) throw new Error('command must not be empty')
      const out = await client.run(session.id, {
        command,
        args: args?.args,
        cwd: args?.cwd,
        env: args?.env,
        wait: Boolean(args?.wait),
        timeoutMs: args?.timeoutMs,
      })
      const app = out.app
      return {
        pid: app.pid ?? 0,
        command: app.command,
        ...(app.log ? { log: app.log } : {}),
        ...(app.exitCode !== undefined ? { exitCode: app.exitCode } : {}),
        ...(app.stdout ? { stdout: app.stdout } : {}),
        ...(app.stderr ? { stderr: app.stderr } : {}),
        ...(app.timedOut ? { timedOut: true } : {}),
      }
    },
  })

  ctx.tools.register({
    name: 'vdesk_browser',
    description:
      'Open Firefox inside this conversation\'s virtual desktop with remote debugging enabled, so the `mcp__firefox__*` '
      + 'tools can attach to it. The browser window stays inside the virtual desktop. Call this before using the Firefox MCP '
      + 'tools; attaching takes one Firefox at a time, so a second browser in another conversation is refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Page to open when the browser starts. Defaults to about:blank.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'marionettePort', 'url'],
        properties: {
          pid: { type: 'integer' },
          marionettePort: { type: 'integer' },
          url: { type: 'string' },
          profile: { type: 'string' },
          reused: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.reused
          ? `a debuggable Firefox is already running inside the virtual desktop (Marionette ${value.marionettePort}); reusing it.`
          : `firefox is running inside the virtual desktop (pid ${value.pid}, Marionette ${value.marionettePort}).\n`
            + 'The Firefox MCP tools can attach now; take a screenshot to confirm the window opened.',
      }],
    },
    async execute(args, exec) {
      const { client, session } = await desktopOf(exec)
      const port = 2828
      const profileDir = `${process.env.HOME}/.mozilla/firefox/vdesk-ff`
      const url = String(args?.url ?? 'about:blank')

      // An attached MCP session owns port 2828; reuse the running browser instead
      // of fighting over the profile lock.
      const probePort = `for i in $(seq 1 ${Math.round(20_000 / 250)}); do (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && exit 0; sleep 0.25; done; exit 1`
      const already = await client.run(session.id, { command: 'sh', args: ['-c', probePort], wait: true, timeoutMs: 22_000 })
      if (already.app.exitCode === 0) {
        return { pid: 0, marionettePort: port, url, profile: profileDir, reused: true }
      }

      // A dedicated profile keeps the user's own Firefox (and its lock) untouched.
      await client.run(session.id, {
        command: 'sh',
        args: ['-c', `[ -d "${profileDir}" ] || firefox -CreateProfile "vdesk-ff ${profileDir}"`],
        wait: true,
        timeoutMs: 30_000,
      })
      const { app } = await client.run(session.id, {
        command: 'firefox',
        args: ['-P', 'vdesk-ff', '--no-remote', '--marionette', '--remote-debugging-port=9222', '--new-window', url],
      })
      const probe = await client.run(session.id, { command: 'sh', args: ['-c', probePort], wait: true, timeoutMs: 22_000 })
      if (probe.app.exitCode !== 0) {
        throw new Error(
          `firefox started (pid ${app.pid}) but Marionette port ${port} never opened; see ${app.log ?? 'the session log'}`,
        )
      }
      return { pid: app.pid, marionettePort: port, url, profile: profileDir }

    },
  })

  ctx.tools.register({
    name: 'vdesk_shot',
    description:
      'Take a screenshot of this conversation\'s virtual desktop and return it as an image you can look at. '
      + 'Use it after starting or interacting with a GUI program to check what actually rendered.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        region: { type: 'string', description: 'Optional crop as "x,y WxH" in desktop pixels, e.g. "0,0 640x480".' },
        maxWidth: { type: 'integer', description: 'Downscale the image to this width before returning it (keeps the aspect ratio).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['width', 'height', 'image'],
        properties: {
          width: { type: 'integer' },
          height: { type: 'integer' },
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<virtual-desktop-screenshot>\n${value.image.mediaType} image, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes\n</virtual-desktop-screenshot>`,
      }, { type: 'image', attachment: value.image }],
    },
    async execute(args, exec) {
      const { client, session } = await desktopOf(exec)
      const png = await client.shotBuffer(session.id, {
        region: args?.region,
        ...(args?.maxWidth ? { maxWidth: Number(args.maxWidth) } : {}),
      })
      const ref = await ctx.attachments.saveImage({
        data: new Uint8Array(png),
        mediaType: 'image/png',
        name: `vdesk-${session.id}-${Date.now()}.png`,
      })
      return {
        width: ref.width,
        height: ref.height,
        image: {
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      }
    },
  })

  ctx.tools.register({
    name: 'vdesk_input',
    description:
      'Send pointer and keyboard input to this conversation\'s virtual desktop. Coordinates are desktop pixels measured from the top-left. '
      + 'Keyboard input goes to the focused window, so click the target first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['actions'],
      properties: {
        actions: {
          type: 'array',
          description: 'Input steps, executed in order.',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['type'],
            properties: {
              type: { type: 'string', enum: ['click', 'move', 'drag', 'scroll', 'type', 'key'] },
              x: { type: 'integer' },
              y: { type: 'integer' },
              button: { type: 'string', description: 'left (default), middle or right.' },
              from: { type: 'array', items: { type: 'integer' }, description: 'drag start [x, y].' },
              to: { type: 'array', items: { type: 'integer' }, description: 'drag end [x, y].' },
              steps: { type: 'integer', description: 'drag interpolation steps, default 12.' },
              direction: { type: 'string', description: 'scroll direction: up, down, left, right.' },
              amount: { type: 'integer', description: 'scroll clicks, default 1.' },
              text: { type: 'string', description: 'text to type, including non-ASCII.' },
              combo: { type: 'string', description: 'key combination such as "ctrl+t", "alt+F4" or "Return".' },
              method: { type: 'string', description: 'type method: auto (default), wtype or paste.' },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['done'],
        properties: {
          done: { type: 'integer' },
          details: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `sent ${value.done} input step(s)` }],
    },
    async execute(args, exec) {
      const { client, session } = await desktopOf(exec)
      const actions = Array.isArray(args?.actions) ? args.actions : []
      if (actions.length === 0) throw new Error('actions must contain at least one input step')
      const out = await client.input(session.id, actions)
      return { done: actions.length, details: out.results ?? [] }
    },
  })

  ctx.tools.register({
    name: 'vdesk_windows',
    description:
      'List the windows currently open in this conversation\'s virtual desktop (app id, title, geometry, focus, pid). '
      + 'Use it to locate a window before clicking or to confirm that a program actually opened one.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['windows'],
        properties: {
          windows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'x', 'y', 'width', 'height', 'focused'],
              properties: {
                id: { type: 'integer' },
                pid: { type: 'integer' },
                appId: { type: 'string' },
                title: { type: 'string' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                focused: { type: 'boolean' },
                x11: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.windows.length === 0
          ? 'no windows are open in this virtual desktop'
          : value.windows.map((w) => `${w.focused ? '*' : ' '} ${w.appId ?? '-'} "${w.title}" ${w.width}x${w.height}+${w.x}+${w.y}`).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const { client, session } = await desktopOf(exec)
      const windows = (await client.windows(session.id)).map((w) => ({
        ...(w.id === undefined ? {} : { id: w.id }),
        ...(w.pid === undefined ? {} : { pid: w.pid }),
        ...(w.appId === null || w.appId === undefined ? {} : { appId: String(w.appId) }),
        title: String(w.title ?? ''),
        x: w.rect?.x ?? 0,
        y: w.rect?.y ?? 0,
        width: w.rect?.width ?? 0,
        height: w.rect?.height ?? 0,
        focused: Boolean(w.focused),
        x11: Boolean(w.x11),
      }))
      return { windows }
    },
  })

  ctx.tools.register({
    name: 'vdesk_resize',
    description: 'Change this conversation\'s virtual desktop resolution. Existing windows are re-laid out by the compositor.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height'],
      properties: {
        width: { type: 'integer', description: 'New width in pixels (320-7680).' },
        height: { type: 'integer', description: 'New height in pixels (240-4320).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['width', 'height'],
        properties: { width: { type: 'integer' }, height: { type: 'integer' } },
      },
      render: (_args, value) => [{ type: 'text', text: `desktop resized to ${value.width}x${value.height}` }],
    },
    async execute(args, exec) {
      const { client, session } = await desktopOf(exec)
      const w = Number(args?.width)
      const h = Number(args?.height)
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 320 || h < 240 || w > 7680 || h > 4320) {
        throw new Error('width/height must be within 320..7680 x 240..4320')
      }
      await client.resize(session.id, Math.round(w), Math.round(h))
      return { width: Math.round(w), height: Math.round(h) }
    },
  })

  ctx.tools.register({
    name: 'vdesk_stop',
    description: 'Stop this conversation\'s virtual desktop and every program running in it. The next vdesk_* call starts a fresh one.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['stopped'],
        properties: { stopped: { type: 'boolean' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.stopped ? 'virtual desktop stopped' : 'no virtual desktop was running' }],
    },
    async execute(_args, exec) {
      const key = sessionIdOf(exec)
      const client = await hub()
      const sessions = await client.sessions()
      const mine = sessions.find((s) => s.key === key)
      if (!mine) return { stopped: false }
      await client.stop(mine.id)
      return { stopped: true }
    },
  })

  ctx.connection.fetch.register({
    path: '/api/vdesk/state',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const session = url.searchParams.get('session') ?? ''
      try {
        const client = await hub()
        const sessions = await client.sessions()
        const mine = sessions.find((s) => s.key === session)
        return Response.json({
          ok: true,
          running: mine !== undefined,
          desktop: mine ?? null,
          hub: { port: client.state.port, token: client.state.token },
          sessionKey: session,
        })
      } catch (error) {
        return Response.json({ ok: false, running: false, error: String(error?.message ?? error) }, { status: 200 })
      }
    },
  })

  ctx.connection.fetch.register({
    path: '/api/vdesk/open',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let session = ''
      try {
        const body = await request.json()
        session = typeof body?.session === 'string' ? body.session : ''
      } catch {
        /* empty body */
      }
      if (!session) return Response.json({ ok: false, error: 'session is required' }, { status: 400 })
      try {
        const out = await ensureFor(session)
        return Response.json({
          ok: true,
          running: true,
          desktop: out.session,
          hub: { port: (await hub()).state.port, token: (await hub()).state.token },
          sessionKey: session,
        })
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 })
      }
    },
  })
}
