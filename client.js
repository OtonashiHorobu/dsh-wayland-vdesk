// dsh-vdesk — Client half. Served verbatim: a classic script that registers one
// lazy factory with the DSH module loader. It contributes three seats:
//   - sidebar.panellist : the icon that opens the full-page overview
//   - main              : the overview page (every desktop of every conversation)
//   - conversation.view : the live view of this conversation's desktop
window.__ModuleLoader__.load({
  id: 'dsh-vdesk',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'vdesk'
    const EN = {
      view: 'Virtual desktop',
      overview: 'Virtual desktops',
      loading: 'Looking for this conversation\u2019s desktop\u2026',
      idle: 'No virtual desktop for this conversation yet.',
      idleHint: 'Open one here, or let the agent call vdesk_create.',
      open: 'Open desktop',
      opening: 'Opening\u2026',
      popup: 'Open in window',
      reload: 'Reload',
      failed: 'The vdesk hub did not answer. Check that the dsh-vdesk daemon can start.',
      overviewFailed: 'The vdesk hub did not answer, so the overview cannot load.',
    }
    const ZH = {
      view: '虚拟桌面',
      overview: '虚拟桌面',
      loading: '正在查找本对话的虚拟桌面…',
      idle: '本对话还没有虚拟桌面。',
      idleHint: '可以在这里直接打开，也可以让 agent 调用 vdesk_create。',
      open: '打开桌面',
      opening: '正在打开…',
      popup: '在窗口打开',
      reload: '重载',
      failed: 'vdesk hub 没有响应，请检查 dsh-vdesk 后台进程能否启动。',
      overviewFailed: 'vdesk hub 没有响应，概览加载不了。',
    }

    const THEME_TOKENS = [
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-layer-3',
      '--dsw-alias-bg-document-preview',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-brand-primary',
      '--dsw-alias-interactive-bg-hover',
      '--dsw-alias-interactive-bg-active',
      '--dsw-specific-sidebar-fill',
      '--dsw-specific-selector',
      '--dsw-alias-card-fill',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-error-primary',
    ]

    function readTheme() {
      const body = document.body
      const computed = getComputedStyle(body)
      const tokens = {}
      for (const name of THEME_TOKENS) {
        const value = computed.getPropertyValue(name).trim()
        if (value) tokens[name] = value
      }
      return {
        type: 'dsh-theme',
        scheme: body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
        font: computed.fontFamily,
        tokens,
      }
    }

    /** Mirror the host theme into a same-machine iframe and keep it in sync. */
    function useThemeBridge() {
      const frame = React.useRef(null)
      const push = React.useCallback(() => {
        const win = frame.current?.contentWindow
        if (!win) return
        try {
          win.postMessage(readTheme(), '*')
        } catch {
          /* frame is gone */
        }
      }, [])
      React.useEffect(() => {
        const observer = new MutationObserver(push)
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
        const onMessage = (event) => {
          if (event.data && event.data.type === 'vdesk-ready') push()
        }
        window.addEventListener('message', onMessage)
        return () => {
          observer.disconnect()
          window.removeEventListener('message', onMessage)
        }
      }, [push])
      return { frame, push }
    }

    const styles = {
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '0 2px 8px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary, #81858c)',
      },
      spacer: { flex: '1 1 auto' },
      ghost: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '20px',
        padding: '0 8px',
        height: '24px',
        color: 'var(--dsw-alias-label-secondary, #61666b)',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: '8px',
        cursor: 'pointer',
      },
      primary: {
        font: 'inherit',
        fontSize: '13px',
        height: '28px',
        padding: '0 14px',
        color: 'var(--dsw-alias-bg-base, #fff)',
        background: 'var(--dsw-alias-brand-primary, #0f1115)',
        border: '0',
        borderRadius: '8px',
        cursor: 'pointer',
      },
      center: {
        height: '100%',
        minHeight: '240px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        padding: '24px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary, #61666b)',
      },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #81858c)' },
      frame: {
        flex: '1 1 auto',
        width: '100%',
        minHeight: '260px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.04))',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-document-preview, #ebeef2)',
        display: 'block',
      },
    }

    function request(path, init) {
      return fetch(path, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        ...init,
      }).then((res) => {
        if (!res.ok) throw new Error('vdesk route failed: HTTP ' + String(res.status))
        return res.json()
      })
    }

    function hubFrameUrl(info, path) {
      const host = window.location.hostname || '127.0.0.1'
      const params = new URLSearchParams({ token: info.hub.token })
      return `http://${host}:${String(info.hub.port)}${path}?${params.toString()}`
    }

    function desktopUrl(info) {
      const host = window.location.hostname || '127.0.0.1'
      const params = new URLSearchParams({ token: info.hub.token, conv: info.sessionKey, embed: '1' })
      return `http://${host}:${String(info.hub.port)}/?${params.toString()}`
    }

    /* --------------------------------------------------- overview panel */

    function VDeskPanel(props) {
      const t = props.t
      const [info, setInfo] = React.useState({ phase: 'loading' })
      const { frame, push } = useThemeBridge()

      React.useEffect(() => {
        request('api/vdesk/hub').then(
          (value) => setInfo(value.ok === false ? { phase: 'failed', error: value.error } : { phase: 'ready', value }),
          () => setInfo({ phase: 'failed' }),
        )
      }, [])

      if (info.phase === 'loading') return h('div', { style: styles.center }, t('loading'))
      if (info.phase === 'failed') {
        return h('div', { style: styles.center },
          h('div', null, t('overviewFailed')),
          info.error ? h('code', { style: { fontSize: '12px', opacity: 0.7 } }, String(info.error)) : null)
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '320px' } },
        h('iframe', {
          ref: frame,
          src: hubFrameUrl(info.value, '/overview'),
          title: t('overview'),
          style: { ...styles.frame, border: '0', borderRadius: '0', flex: '1 1 auto' },
          referrerPolicy: 'no-referrer',
          onLoad: push,
        }))
    }

    function VDeskIcon() {
      return h('svg', {
        viewBox: '0 0 20 20',
        width: 18,
        height: 18,
        'aria-hidden': true,
        style: { display: 'block' },
      }, h('rect', {
        x: 2.4, y: 3.6, width: 15.2, height: 10.4, rx: 2.2,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
      }), h('path', {
        d: 'M7 16.8h6',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }))
    }

    /* ---------------------------------------------------- session view */

    /**
     * While the desktop is the visible view, the conversation's content-width
     * drag handles sit on top of the frame and steal drags. They carry a stable
     * `data-width-handle` attribute, so lock them for as long as this view is
     * the one on screen.
     */
    function useWidthHandleLock(visible) {
      const root = React.useRef(null)
      React.useEffect(() => {
        const style = document.createElement('style')
        style.dataset.vdesk = 'width-handle-lock'
        style.textContent = 'body.vdesk-live [data-width-handle]{pointer-events:none!important}'
        document.head.append(style)
        const sync = () => {
          const node = root.current
          const onScreen = Boolean(node && node.isConnected && node.offsetParent !== null && node.getBoundingClientRect().height > 0)
          document.body.classList.toggle('vdesk-live', onScreen)
        }
        sync()
        const timer = setInterval(sync, 400)
        return () => {
          clearInterval(timer)
          document.body.classList.remove('vdesk-live')
          style.remove()
        }
      }, [])
      return root
    }

    function VDeskView(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const t = props.t
      const [info, setInfo] = React.useState({ phase: 'loading' })
      const [busy, setBusy] = React.useState(false)
      const { frame, push } = useThemeBridge()
      const root = useWidthHandleLock()

      const load = React.useCallback(() => {
        if (!sessionId) return
        request('api/vdesk/state?session=' + encodeURIComponent(sessionId)).then(
          (value) => setInfo({ phase: 'ready', value }),
          () => setInfo({ phase: 'failed' }),
        )
      }, [sessionId])

      React.useEffect(() => {
        load()
        const timer = setInterval(() => {
          setInfo((current) => {
            if (current.phase !== 'ready' || current.value?.running !== true) load()
            return current
          })
        }, 4000)
        return () => clearInterval(timer)
      }, [load])

      const open = () => {
        setBusy(true)
        fetch('api/vdesk/open', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ session: sessionId }),
        })
          .then(() => load())
          .catch(() => setInfo({ phase: 'failed' }))
          .finally(() => setBusy(false))
      }

      const value = info.phase === 'ready' ? info.value : undefined
      const running = value?.ok === true && value?.running === true
      const url = running ? desktopUrl(value) : ''

      if (info.phase === 'loading') return h('div', { style: styles.center }, t('loading'))

      if (info.phase === 'failed' || value?.ok === false) {
        return h('div', { style: styles.center },
          h('div', null, t('failed')),
          h('button', { type: 'button', style: styles.primary, onClick: load }, t('reload')))
      }

      if (!running) {
        return h('div', { style: styles.center },
          h('div', null, t('idle')),
          h('div', { style: styles.hint }, t('idleHint')),
          h('button', { type: 'button', style: styles.primary, disabled: busy, onClick: open },
            busy ? t('opening') : t('open')))
      }

      return h('div', { ref: root, style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '300px' } },
        h('div', { style: styles.row },
          h('span', null,
            String(value.desktop?.width ?? '') + '\u00d7' + String(value.desktop?.height ?? '')
            + (value.desktop?.x11Display ? ' \u00b7 ' + String(value.desktop.x11Display) : '')),
          h('span', { style: styles.spacer }),
          h('button', { type: 'button', style: styles.ghost, onClick: () => window.open(url, '_blank', 'noopener') }, t('popup')),
          h('button', { type: 'button', style: styles.ghost, onClick: load }, t('reload'))),
        h('iframe', {
          ref: frame,
          src: url,
          title: t('view'),
          style: styles.frame,
          referrerPolicy: 'no-referrer',
          allow: 'clipboard-read; clipboard-write; fullscreen',
          onLoad: push,
        }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'vdesk: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'vdesk', order: 40, label: () => t('overview'), locale: NS },
            VDeskIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'vdesk', locale: NS }, VDeskPanel),
        )
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            { name: 'conversation.view', id: 'vdesk', order: 60, label: () => t('view'), locale: NS },
            VDeskView,
          ),
        )
      },
    }
  },
})
