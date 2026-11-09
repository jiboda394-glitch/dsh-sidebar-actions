/**
 * dsh-sidebar-actions — Host half.
 *
 * Puts refresh / restart / quit in the sidebar footer and performs the desktop
 * half of restart and quit. The page itself does the refresh (location.reload).
 *
 * Two mechanisms, picked automatically per machine:
 *
 * 1. "shell bridge" — a desktop main process that polls
 *    %LOCALAPPDATA%\dsh-restart.request and %LOCALAPPDATA%\dsh-quit.request and
 *    calls app.relaunch()/app.quit(). Graceful: it takes the same path as the
 *    tray menu, including the native "running tasks will be interrupted" prompt.
 *    This needs a one-line addition to the desktop shell, so it only exists on
 *    machines that installed it: the shell declares itself by creating
 *    %LOCALAPPDATA%\dsh-restart.bridge, and the plugin only uses this path when
 *    that marker is there.
 *
 * 2. "detached helper" — a per-user scheduled task runs scripts/dsh-stop.ps1
 *    outside the application's process tree. It stops the shell process and,
 *    for a restart, starts the same executable again with its original command
 *    line. This works on an unpatched app, but it is a forced stop: running
 *    tasks are interrupted without the native prompt, which is why the page asks
 *    for a second click first and says so in the tooltip.
 *
 * Health and mode are exposed on GET /dsh-sidebar-actions/api/state so the
 * buttons can explain themselves instead of failing silently.
 */

import { spawn } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-sidebar-actions'
export const inject = ['webServer']

const PREFIX = '/dsh-sidebar-actions/api'
const TASK_NAME = 'DSH-SidebarActions'
const PKG_DIR = dirname(fileURLToPath(import.meta.url))

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows'
const POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const SCHTASKS = join(SYSTEM_ROOT, 'System32', 'schtasks.exe')

/** Same per-user base the shell bridge reads from. */
function userLocalBase() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA
  if (process.platform === 'win32') return join(process.env.USERPROFILE || 'C:\\Windows\\Temp', 'AppData', 'Local')
  return join(process.env.XDG_STATE_HOME || join(process.env.HOME || '.', '.local', 'state'))
}

const BASE = userLocalBase()
const STATE_DIR = join(BASE, 'dsh-sidebar-actions')
const LOG = join(STATE_DIR, 'host.log')
const REQUEST = join(STATE_DIR, 'request.json')
const LAUNCHER = join(STATE_DIR, 'launcher.vbs')

/** Contract with the optional desktop shell bridge. */
const BRIDGE_RESTART = join(BASE, 'dsh-restart.request')
const BRIDGE_QUIT = join(BASE, 'dsh-quit.request')
/**
 * Declared by a shell that polls the two files above. A file, not an archive
 * scan: the desktop host runs with Electron's patched `fs`, where reading the
 * whole `app.asar` back through a descriptor is not a supported operation.
 * A stale marker is harmless — an ignored request falls back to the helper.
 */
const BRIDGE_MARKER = join(BASE, 'dsh-restart.bridge')

let version = '0.0.0'
try {
  version = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version ?? version
} catch {
  /* the manifest is optional at runtime */
}

function ensureStateDir() {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
  } catch {
    /* a read-only state directory only costs us the log */
  }
}

function note(line) {
  try {
    ensureStateDir()
    if (existsSync(LOG) && statSync(LOG).size > 262144) renameSync(LOG, `${LOG}.1`)
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never break the request */
  }
}

function logTail(bytes = 2048) {
  try {
    const size = statSync(LOG).size
    const fd = openSync(LOG, 'r')
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, Math.max(0, size - length))
    closeSync(fd)
    return buffer.toString('utf8').trim().split('\n').slice(-12).join('\n')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * Desktop detection
 * ------------------------------------------------------------------ */

function asarPath() {
  const resources = process.resourcesPath
  return typeof resources === 'string' && resources !== '' ? join(resources, 'app.asar') : ''
}

let bridgeCache = { at: 0, value: false }

/** True when the running shell declares (and polls) our request files. */
function hasShellBridge(force = false) {
  const now = Date.now()
  if (!force && now - bridgeCache.at < 60000) return bridgeCache.value
  let value = false
  try {
    value = existsSync(BRIDGE_MARKER)
  } catch (error) {
    note(`bridge probe failed: ${error?.message ?? error}`)
  }
  bridgeCache = { at: now, value }
  return value
}

function desktopInfo() {
  const electron = typeof process.versions?.electron === 'string'
  const archive = asarPath()
  const desktop = electron && process.env.ELECTRON_RUN_AS_NODE === '1' && archive !== '' && existsSync(archive)
  return {
    desktop,
    bridge: desktop ? hasShellBridge() : false,
    platform: process.platform,
    archive,
    shellPid: process.ppid,
    shellExe: process.execPath,
  }
}

let versionCache

/** The shell's own version, read the way Electron's asar layer supports. */
function readDshVersion() {
  if (versionCache !== undefined) return versionCache
  versionCache = null
  try {
    const manifest = join(process.resourcesPath ?? '', 'app.asar', 'package.json')
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed?.version === 'string') versionCache = parsed.version
  } catch {
    /* version reporting is optional */
  }
  return versionCache
}

/**
 * Confirm the process we are about to stop really is the desktop shell.
 *
 * The host is spawned by the shell, so `process.ppid` is the shell — as long as
 * that stays true. A future shell that adds a wrapper would make the pid point
 * at something else, and blindly killing it is the one mistake this plugin must
 * not make. Returns ok:true when the check cannot run at all, because a missing
 * PowerShell should not disable an otherwise working restart.
 */
function verifyShell() {
  const pid = process.ppid
  const exe = process.execPath
  if (process.platform !== 'win32' || !existsSync(POWERSHELL) || pid <= 0) {
    return Promise.resolve({ ok: true, detail: 'unchecked' })
  }
  const quotedPid = String(pid)
  const quotedExe = `'${String(exe).replace(/'/g, "''")}'`
  const command = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${quotedPid}" -ErrorAction SilentlyContinue`,
    `if ($null -eq $p) { 'missing' }`,
    `elseif ($p.ExecutablePath -ne ${quotedExe}) { 'mismatch:' + $p.ExecutablePath }`,
    `elseif ($p.CommandLine -match '--type=') { 'child' }`,
    `else { 'ok' }`,
  ].join('; ')

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = spawn(
        POWERSHELL,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      )
      let out = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        out += chunk
      })
      child.on('error', () => finish({ ok: true, detail: 'unchecked' }))
      child.on('exit', () => finish(interpretShellProbe(out)))
      setTimeout(() => finish({ ok: true, detail: 'probe timed out' }), 4000).unref?.()
    } catch {
      finish({ ok: true, detail: 'unchecked' })
    }
  })
}

function interpretShellProbe(output) {
  const text = String(output || '').trim().split('\n').pop()?.trim() ?? ''
  if (text === 'ok' || text === '') return { ok: true, detail: 'ok' }
  if (text === 'missing') return { ok: false, detail: 'the shell process is gone' }
  if (text === 'child') return { ok: false, detail: 'the parent is a child process, not the shell' }
  if (text.startsWith('mismatch:')) {
    return { ok: false, detail: `the parent runs a different executable: ${text.slice('mismatch:'.length)}` }
  }
  return { ok: true, detail: `unrecognised probe answer: ${text}` }
}

function modeOf(info) {
  if (!info.desktop) return 'unsupported'
  return info.bridge ? 'graceful' : 'forced'
}

/* ------------------------------------------------------------------ *
 * Forced path: launcher + scheduled task + helper
 * ------------------------------------------------------------------ */

function vbsString(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

function writeLauncher() {
  const script = join(PKG_DIR, 'scripts', 'dsh-stop.ps1')
  const tokens = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    script,
    '-RequestPath',
    REQUEST,
  ]
  const command = tokens.map((part) => (/[\s"]/.test(part) ? vbsString(part) : part)).join(' ')

  const body = [
    "' dsh-sidebar-actions: hidden launcher for the stop/restart helper.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run ${vbsString(command)}, 0, False`,
    '',
  ].join('\r\n')
  writeFileSync(LAUNCHER, body, 'utf8')
  note(`launcher written: ${LAUNCHER}`)
}

let taskState = { ready: false, detail: 'not checked', at: 0 }
let taskRun = null

/** Registers (or repairs) the per-user task; cached for five minutes. */
function ensureTask(force = false) {
  const now = Date.now()
  if (!force && taskRun === null && taskState.at !== 0 && now - taskState.at < 300000) {
    return Promise.resolve(taskState)
  }
  if (taskRun !== null) return taskRun

  const script = join(PKG_DIR, 'scripts', 'ensure-task.ps1')
  if (process.platform !== 'win32') {
    taskState = { ready: false, detail: 'scheduled helper is Windows only', at: now }
    return Promise.resolve(taskState)
  }
  if (!existsSync(POWERSHELL) || !existsSync(script)) {
    taskState = { ready: false, detail: 'helper scripts are missing', at: now }
    return Promise.resolve(taskState)
  }

  taskRun = new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      taskState = { ...value, at: Date.now() }
      taskRun = null
      resolve(taskState)
    }
    try {
      ensureStateDir()
      writeLauncher()
      const child = spawn(
        POWERSHELL,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          script,
          '-TaskName',
          TASK_NAME,
          '-Launcher',
          LAUNCHER,
          '-Log',
          LOG,
        ],
        { stdio: 'ignore', windowsHide: true },
      )
      child.on('error', (error) => finish({ ready: false, detail: `spawn failed: ${error?.message ?? error}` }))
      child.on('exit', (code) => finish({ ready: code === 0, detail: `ensure-task exited ${code}` }))
      setTimeout(() => finish({ ready: false, detail: 'ensure-task timed out' }), 30000).unref?.()
    } catch (error) {
      finish({ ready: false, detail: `ensure failed: ${error?.message ?? error}` })
    }
  })
  return taskRun
}

function runTask() {
  if (process.platform !== 'win32' || !existsSync(SCHTASKS)) {
    note('schtasks unavailable')
    return false
  }
  try {
    const child = spawn(SCHTASKS, ['/run', '/tn', TASK_NAME], { stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => note(`schtasks spawn error: ${error?.message ?? error}`))
    child.on('exit', (code) => note(`schtasks /run exited ${code}`))
    return true
  } catch (error) {
    note(`schtasks failed: ${error?.message ?? error}`)
    return false
  }
}

function writeRequest(action) {
  ensureStateDir()
  const payload = {
    action,
    pid: process.ppid,
    exe: process.execPath,
    plugin: name,
    version,
    createdAt: new Date().toISOString(),
  }
  writeFileSync(REQUEST, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  note(`forced ${action} queued for pid ${payload.pid}`)
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function writeBridgeRequest(action) {
  const file = action === 'quit' ? BRIDGE_QUIT : BRIDGE_RESTART
  try {
    ensureStateDir()
    writeFileSync(file, new Date().toISOString(), 'utf8')
    note(`bridge ${action} request written: ${file}`)
  } catch (error) {
    note(`bridge request failed: ${error?.message ?? error}`)
    return false
  }

  // The bridge is detected, not guaranteed: if the shell ignores the file
  // (e.g. the app was updated and lost the patch) fall back to the helper.
  setTimeout(() => {
    try {
      if (!existsSync(file)) return
      rmSync(file, { force: true })
      note('bridge request was not consumed; falling back to the helper')
      void forced(action)
    } catch (error) {
      note(`bridge fallback failed: ${error?.message ?? error}`)
    }
  }, 2500).unref?.()

  return true
}

async function forced(action) {
  const shell = await verifyShell()
  if (!shell.ok) {
    note(`forced ${action} refused: ${shell.detail}`)
    return { ok: false, error: 'shell-not-found', detail: shell.detail }
  }
  const task = await ensureTask()
  if (!task.ready) {
    note(`forced ${action} skipped: ${task.detail}`)
    return { ok: false, error: 'helper-unavailable', detail: task.detail }
  }
  try {
    writeRequest(action)
  } catch (error) {
    note(`request write failed: ${error?.message ?? error}`)
    return { ok: false, error: 'request-write-failed', detail: String(error?.message ?? error) }
  }
  // Let the HTTP response reach the page before the task starts.
  setTimeout(() => {
    if (!runTask()) note('forced action could not start the helper')
  }, 150).unref?.()
  return { ok: true, via: 'forced' }
}

async function perform(action) {
  const info = desktopInfo()
  if (!info.desktop) return { ok: false, error: 'desktop-only' }
  if (info.bridge && writeBridgeRequest(action)) return { ok: true, via: 'graceful' }
  return forced(action)
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Same-origin gate: only the page this server rendered may trigger actions. */
function rejectRequest(req) {
  try {
    const site = req.headers?.['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') return true
    const origin = req.headers?.origin
    const host = req.headers?.host
    if (origin && host) {
      try {
        if (new URL(origin).host !== host) return true
      } catch {
        return true
      }
    }
    if (req.method === 'POST') {
      const type = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (type && type !== 'application/json' && type !== 'text/plain') return true
    }
    return false
  } catch {
    return true
  }
}

/** Last state request that came from the page itself (not a local probe). */
let clientProbe = null

/** Filled by apply(): what this composition actually gave the plugin. */
const apiState = { routeReady: false, webServerRegister: false, slot: 'sidebar.footer.action' }

function statePayload(extra = {}) {
  const info = desktopInfo()
  return {
    ok: true,
    name,
    version,
    platform: info.platform,
    desktop: info.desktop,
    bridge: info.bridge,
    via: modeOf(info),
    shellPid: info.shellPid,
    shellExe: info.shellExe,
    task: { name: TASK_NAME, ready: taskState.ready, detail: taskState.detail },
    pkgDir: PKG_DIR,
    dshVersion: readDshVersion(),
    api: { ...apiState },
    clientProbe,
    stateDir: STATE_DIR,
    ...extra,
  }
}

export function apply(ctx) {
  ensureStateDir()
  note(`plugin ${version} applied on ${process.platform} (ppid ${process.ppid})`)

  apiState.webServerRegister = typeof ctx?.webServer?.register === 'function'
  if (!apiState.webServerRegister) note('webServer.register unavailable — restart and quit are disabled')

  // Best effort: register the helper task early so the first click is quick and
  // /state can report readiness. In graceful mode it is only the fallback.
  if (desktopInfo().desktop && process.platform === 'win32') void ensureTask()

  const handlers = {
    /**
     * Read-only readiness report. Everything restart and quit depend on, without
     * stopping anything: the shell pid resolution, the helper task, the bridge,
     * the plugin package that is serving this route, and the shell version.
     */
    '/diagnose': async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const shell = await verifyShell()
      const task = await ensureTask()
      sendJson(
        res,
        200,
        statePayload({
          ok: true,
          shell,
          task,
          bridgeMarker: { path: BRIDGE_MARKER, present: existsSync(BRIDGE_MARKER) },
          requestFile: REQUEST,
          launcher: LAUNCHER,
          checks: {
            desktop: desktopInfo().desktop,
            shellReachable: shell.ok,
            helperReady: task.ready,
            routeReady: apiState.routeReady,
            clientMounted: clientProbe !== null,
          },
          log: logTail(),
        }),
      )
    },
    '/state': async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // Refresh the bridge probe on demand (an app update can remove it).
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.searchParams.get('refresh') === '1') hasShellBridge(true)
      sendJson(res, 200, statePayload({ log: logTail() }))
    },
    '/restart': async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const result = await perform('restart')
      sendJson(res, result.ok ? 200 : 409, statePayload(result))
    },
    '/quit': async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const result = await perform('quit')
      sendJson(res, result.ok ? 200 : 409, statePayload(result))
    },
  }

  const handler = async (req, res) => {
    if (rejectRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const route = url.pathname.startsWith(PREFIX)
      ? url.pathname.slice(PREFIX.length).replace(/\/+$/, '') || '/'
      : url.pathname.replace(/\/+$/, '') || '/'
    const routeHandler = handlers[route]
    if (routeHandler === undefined) {
      sendJson(res, 404, { ok: false, error: 'unknown route' })
      return
    }
    // A browser adds fetch metadata; local probes (curl, tests) do not. That
    // makes this a cheap proof the page half really is mounted and asking.
    if (route === '/state' && typeof req.headers?.['sec-fetch-site'] === 'string') {
      clientProbe = {
        at: new Date().toISOString(),
        site: req.headers['sec-fetch-site'],
        ua: String(req.headers['user-agent'] || '').slice(0, 120),
      }
    }
    try {
      await routeHandler(req, res)
    } catch (error) {
      note(`route ${route} failed: ${error?.stack ?? error}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' })
    }
  }

  if (ctx?.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
      `${name}: api route`,
    )
    apiState.routeReady = true
    note(`api route registered (dsh ${readDshVersion() ?? 'unknown'})`)
  } else {
    note('webServer.register unavailable — restart and quit are disabled')
  }
}
