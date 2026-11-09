/**
 * dsh-sidebar-actions — Web half.
 *
 * Three actions in the sidebar footer (`sidebar.footer.action`):
 *   refresh  reloads the page
 *   restart  restarts the desktop app through the host half
 *   quit     quits the desktop app through the host half
 *
 * Restart and quit ask for a second click first: on a machine without the
 * graceful shell bridge they can interrupt running tasks.
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-actions',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = 'dsh-sidebar-actions/api'
    const SLOT = 'sidebar.footer.action'

    const TEXT = {
      zh: {
        reload: '刷新',
        reloading: '刷新中',
        restart: '重启',
        restarting: '重启中',
        quit: '退出',
        quitting: '退出中',
        actions: '快捷操作',
        reloadTitle: '刷新界面（重新加载页面）',
        restartTitle: '重启 DeepSeek Harness',
        quitTitle: '退出 DeepSeek Harness',
        armedRestart: '再点一次重启',
        armedQuit: '再点一次退出',
        desktopOnly: '仅桌面版支持重启和退出；刷新始终可用',
        forcedHint: '将强制结束进程并重新启动，正在运行的任务会被中断',
        gracefulHint: '通过与托盘菜单相同的优雅路径重启',
        quitForcedHint: '将强制结束进程，正在运行的任务会被中断',
        quitGracefulHint: '通过与托盘菜单相同的优雅路径退出',
        noEffect: '没有响应：请改用托盘菜单',
        failed: '请求失败',
        unsupported: '当前环境不支持',
        bridgeMissing: '未安装优雅退出桥接，正在使用强制方式',
      },
      en: {
        reload: 'Reload',
        reloading: 'Reloading',
        restart: 'Restart',
        restarting: 'Restarting',
        quit: 'Quit',
        quitting: 'Quitting',
        actions: 'Quick actions',
        reloadTitle: 'Reload the page',
        restartTitle: 'Restart DeepSeek Harness',
        quitTitle: 'Quit DeepSeek Harness',
        armedRestart: 'Click again to restart',
        armedQuit: 'Click again to quit',
        desktopOnly: 'Restart and quit need the desktop app; reload always works',
        forcedHint: 'Force-stops the process and starts it again; running tasks are interrupted',
        gracefulHint: 'Restarts through the same graceful path as the tray menu',
        quitForcedHint: 'Force-stops the process; running tasks are interrupted',
        quitGracefulHint: 'Quits through the same graceful path as the tray menu',
        noEffect: 'No response — use the tray menu instead',
        failed: 'Request failed',
        unsupported: 'Not supported here',
        bridgeMissing: 'No graceful bridge; the forced path is in use',
      },
    }

    function currentLang() {
      try {
        const lang = String(document?.documentElement?.lang ?? '').toLowerCase()
        return lang.startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    /** Re-renders when the app language changes. */
    function useLang() {
      const [lang, setLang] = useState(currentLang)
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const root = document.documentElement
        if (!root || typeof MutationObserver === 'undefined') return undefined
        const observer = new MutationObserver(() => setLang(currentLang()))
        observer.observe(root, { attributes: true, attributeFilter: ['lang'] })
        return () => observer.disconnect()
      }, [])
      return lang
    }

    function apiUrl(route) {
      try {
        return new URL(`${API}/${route}`, document.baseURI).href
      } catch {
        return `/${API}/${route}`
      }
    }

    const ICONS = {
      reload(spinning) {
        return h(
          'svg',
          {
            width: 15,
            height: 15,
            viewBox: '0 0 24 24',
            fill: 'none',
            'aria-hidden': true,
            style: spinning ? { animation: 'dsa-spin 1s linear infinite' } : undefined,
          },
          h('path', {
            d: 'M4.8 12a7.2 7.2 0 0 1 12.4-5M19.2 12a7.2 7.2 0 0 1-12.4 5',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
          }),
          h('path', {
            d: 'M17.6 3.6v3.6h-3.6M6.4 20.4v-3.6h3.6',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )
      },
      restart(spinning) {
        return h(
          'svg',
          {
            width: 15,
            height: 15,
            viewBox: '0 0 24 24',
            fill: 'none',
            'aria-hidden': true,
            style: spinning ? { animation: 'dsa-spin 1s linear infinite' } : undefined,
          },
          h('path', {
            d: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )
      },
      quit() {
        return h(
          'svg',
          { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M12 3.5v7.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
          h('path', {
            d: 'M7.9 6.4a6.6 6.6 0 1 0 8.2 0',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )
      },
    }

    const STYLE = `
      .dsa-row { display: inline-flex; align-items: center; gap: 2px; }
      .dsa-btn {
        display: inline-flex; align-items: center; gap: 5px;
        height: 28px; padding: 0 7px; border: 0; border-radius: 6px;
        background: transparent; color: inherit; font: inherit; font-size: 12px;
        cursor: pointer; opacity: .82; white-space: nowrap;
      }
      .dsa-btn:hover { background: rgba(127,127,127,.16); opacity: 1; }
      .dsa-btn:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
      .dsa-btn:disabled { cursor: default; opacity: .45; }
      .dsa-btn svg { flex: none; }
      .dsa-quit:hover { background: rgba(229,72,77,.14); color: #e5484d; }
      .dsa-armed { background: rgba(229,72,77,.16) !important; color: #e5484d !important; opacity: 1 !important; }
      .dsa-rail { display: inline-flex; }
      .dsa-backdrop { position: fixed; inset: 0; z-index: 2998; }
      .dsa-popover {
        position: fixed; z-index: 2999; min-width: 176px; padding: 4px;
        border-radius: 10px; background: var(--dsw-specific-sidebar-fill, #2b2b2b);
        box-shadow: 0 8px 28px rgba(0,0,0,.34); border: 1px solid rgba(127,127,127,.22);
        display: flex; flex-direction: column; gap: 2px;
      }
      .dsa-popover .dsa-btn { justify-content: flex-start; width: 100%; height: 30px; }
      .dsa-note { padding: 4px 8px 6px; font-size: 11px; opacity: .6; line-height: 1.45; }
      .dsa-alert {
        display: inline-flex; align-items: center; justify-content: center;
        width: 16px; height: 16px; margin-left: 2px; border-radius: 50%;
        font-size: 11px; line-height: 1; font-weight: 600;
        background: rgba(229,72,77,.16); color: #e5484d;
      }
      @keyframes dsa-spin { to { transform: rotate(360deg) } }
      @media (prefers-reduced-motion: reduce) {
        .dsa-btn svg { animation: none !important; }
      }
    `

    function QuickActions(props) {
      const wide = props?.wide !== false
      const lang = useLang()
      const t = TEXT[lang]

      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(null)
      const [armed, setArmed] = useState(null)
      const [notice, setNotice] = useState(null)
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState(null)

      const timers = useRef([])
      const trigger = useRef(null)
      const alive = useRef(true)

      const later = useCallback((fn, ms) => {
        const id = setTimeout(fn, ms)
        timers.current.push(id)
        return id
      }, [])

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
          for (const id of timers.current) clearTimeout(id)
          timers.current = []
        }
      }, [])

      useEffect(() => {
        let active = true
        const load = async () => {
          try {
            const response = await fetch(apiUrl('state'), { cache: 'no-store' })
            if (!response.ok) return
            const value = await response.json()
            if (active && value && typeof value === 'object') setStatus(value)
          } catch {
            /* the buttons still work without the probe */
          }
        }
        void load()
        return () => {
          active = false
        }
      }, [])

      useEffect(() => {
        if (armed === null) return undefined
        const id = setTimeout(() => {
          if (alive.current) setArmed(null)
        }, 4000)
        return () => clearTimeout(id)
      }, [armed])

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [open])

      const mode = status?.via ?? 'unknown'
      const unsupported = mode === 'unsupported'
      const forced = mode === 'forced'

      const titleFor = useCallback(
        (kind) => {
          if (kind === 'reload') return t.reloadTitle
          if (unsupported) return t.desktopOnly
          if (kind === 'restart') return `${t.restartTitle}\n${forced ? t.forcedHint : t.gracefulHint}`
          return `${t.quitTitle}\n${forced ? t.quitForcedHint : t.quitGracefulHint}`
        },
        [forced, t, unsupported],
      )

      const label = useCallback(
        (kind) => {
          if (busy === kind) return t[`${kind}ing`] ?? t[kind]
          if (armed === kind) return kind === 'restart' ? t.armedRestart : t.armedQuit
          return t[kind]
        },
        [armed, busy, t],
      )

      const run = useCallback(
        async (kind) => {
          if (busy) return
          setNotice(null)

          if (kind === 'reload') {
            setBusy('reload')
            later(() => {
              try {
                location.reload()
              } catch {
                if (alive.current) setBusy(null)
              }
            }, 70)
            return
          }

          if (unsupported) {
            setNotice(t.desktopOnly)
            return
          }

          if (armed !== kind) {
            setArmed(kind)
            return
          }

          setArmed(null)
          setOpen(false)
          setBusy(kind)

          try {
            const response = await fetch(apiUrl(kind), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
              cache: 'no-store',
            })
            let payload = null
            try {
              payload = await response.json()
            } catch {
              payload = null
            }
            if (!response.ok || payload?.ok === false) {
              const detail = payload?.detail || payload?.error || `HTTP ${response.status}`
              if (alive.current) {
                setBusy(null)
                setNotice(`${t.failed}: ${detail}`)
              }
              return
            }
            if (payload) setStatus(payload)
            // The app should go away within a few seconds; if it does not,
            // say so instead of spinning forever.
            later(() => {
              if (!alive.current) return
              setBusy(null)
              setNotice(t.noEffect)
            }, 9000)
          } catch (error) {
            const message = String(error?.message ?? error)
            // A dropped connection usually means the process is already gone.
            if (/Failed to fetch|NetworkError|load failed|network/i.test(message)) {
              later(() => {
                if (!alive.current) return
                setBusy(null)
                setNotice(t.noEffect)
              }, 9000)
              return
            }
            if (alive.current) {
              setBusy(null)
              setNotice(`${t.failed}: ${message}`)
            }
          }
        },
        [armed, busy, later, t, unsupported],
      )

      const toggle = useCallback(() => {
        if (open) {
          setOpen(false)
          return
        }
        try {
          const rect = trigger.current?.getBoundingClientRect()
          if (rect) setAnchor({ left: Math.round(rect.left), bottom: Math.round(window.innerHeight - rect.top + 6) })
        } catch {
          setAnchor(null)
        }
        setOpen(true)
      }, [open])

      const button = (kind, options = {}) => {
        const spinning = busy === kind
        const isArmed = armed === kind
        const disabled = busy !== null || (kind !== 'reload' && unsupported)
        return h(
          'button',
          {
            type: 'button',
            className: `dsa-btn${kind === 'quit' ? ' dsa-quit' : ''}${isArmed ? ' dsa-armed' : ''}${
              options.iconOnly ? ' dsa-icon-only' : ''
            }`,
            title: options.iconOnly ? `${label(kind)} — ${titleFor(kind)}` : titleFor(kind),
            'aria-label': `${titleFor(kind).split('\n')[0]}`,
            disabled,
            onClick: (event) => {
              event.stopPropagation()
              void run(kind)
            },
          },
          ICONS[kind](spinning),
          options.iconOnly ? null : h('span', null, label(kind)),
        )
      }

      const hint = notice ? h('div', { className: 'dsa-note', role: 'alert' }, notice) : null
      const alertBadge = notice
        ? h('span', { className: 'dsa-alert', role: 'alert', title: notice }, '!')
        : null

      if (wide) {
        return h(
          'div',
          { className: 'dsa-row', role: 'group', 'aria-label': t.actions },
          h('style', null, STYLE),
          button('reload'),
          button('restart'),
          button('quit'),
          alertBadge,
        )
      }

      return h(
        React.Fragment,
        null,
        h('style', null, STYLE),
        h(
          'div',
          { className: 'dsa-rail' },
          h(
            'button',
            {
              type: 'button',
              ref: trigger,
              className: `dsa-btn${open ? ' dsa-armed' : ''}`,
              title: `${t.actions}${forced ? ` — ${t.bridgeMissing}` : ''}`,
              'aria-label': t.actions,
              'aria-expanded': open ? 'true' : 'false',
              disabled: busy !== null,
              onClick: (event) => {
                event.stopPropagation()
                toggle()
              },
            },
            ICONS.quit(),
          ),
          open ? h('div', { className: 'dsa-backdrop', onClick: () => setOpen(false) }) : null,
          open
            ? h(
                'div',
                {
                  className: 'dsa-popover',
                  role: 'menu',
                  style: anchor
                    ? { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` }
                    : { left: '12px', bottom: '64px' },
                },
                button('reload', { iconOnly: false }),
                button('restart'),
                button('quit'),
                hint,
                forced ? h('div', { className: 'dsa-note' }, t.bridgeMissing) : null,
              )
            : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: 'sidebar-actions',
                order: 40,
              },
              QuickActions,
            ),
          )
        } catch (error) {
          console.error('[dsh-sidebar-actions] sidebar registration failed', error)
        }
      },
    }
  },
})
