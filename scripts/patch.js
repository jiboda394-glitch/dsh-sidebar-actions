/**
 * dsh-sidebar-actions: build a copy of a DeepSeek Harness `app.asar` that also
 * polls the two request files (`dsh-restart.request`, `dsh-quit.request`).
 *
 * Why this exists: the desktop main process is the only place that can call
 * `app.relaunch()` / `app.quit()` on request, and a sidecar plugin cannot reach
 * it. A small poller inside `lib/main.js` is the whole bridge. DSH replaces
 * `app.asar` on every update, so the plugin rebuilds the patched copy for the
 * installed version instead of asking the user to run a tool by hand.
 *
 * The archive is copied byte for byte and only the `lib/main.js` entry is
 * replaced (the patched script is appended at the end, then the header is
 * rewritten). The build refuses to touch a package whose layout it does not
 * recognise, and does nothing when the pollers are already present.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'

const RESTART_MARKER = 'dsh-restart: request poll failed'
const QUIT_MARKER = 'dsh-quit: request poll failed'
const TRAY_ANCHOR = '\t} catch (error) {\n\t\tconsole.warn("desktop tray: unavailable", error);\n\t}\n'

const RESTART_BLOCK = [
  '',
  '\t// dsh-sidebar-actions: graceful relaunch requested from the sidebar.',
  '\t{',
  '\t\tconst restartRequestFile = join(process.env.LOCALAPPDATA || app.getPath("temp"), "dsh-restart.request");',
  '\t\tsetInterval(() => {',
  '\t\t\ttry {',
  '\t\t\t\tif (existsSync(restartRequestFile)) {',
  '\t\t\t\t\trmSync(restartRequestFile, { force: true });',
  '\t\t\t\t\tapp.relaunch();',
  '\t\t\t\t\tapp.quit();',
  '\t\t\t\t}',
  '\t\t\t} catch (error) {',
  '\t\t\t\tconsole.warn("dsh-restart: request poll failed", error);',
  '\t\t\t}',
  '\t\t}, 1000);',
  '\t}',
  '',
].join('\n')

const QUIT_BLOCK = [
  '',
  '\t// dsh-sidebar-actions: graceful quit requested from the sidebar.',
  '\t{',
  '\t\tconst quitRequestFile = join(process.env.LOCALAPPDATA || app.getPath("temp"), "dsh-quit.request");',
  '\t\tsetInterval(() => {',
  '\t\t\ttry {',
  '\t\t\t\tif (existsSync(quitRequestFile)) {',
  '\t\t\t\t\trmSync(quitRequestFile, { force: true });',
  '\t\t\t\t\tapp.quit();',
  '\t\t\t\t}',
  '\t\t\t} catch (error) {',
  '\t\t\t\tconsole.warn("dsh-quit: request poll failed", error);',
  '\t\t\t}',
  '\t\t}, 1000);',
  '\t}',
  '',
].join('\n')

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Reads the archive header and the packed `lib/main.js` entry. */
function readMainArchive(filename) {
  const fd = openSync(filename, 'r')
  try {
    const prefix = Buffer.alloc(16)
    const size = fstatSync(fd).size
    if (readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length) {
      throw new Error(`truncated ASAR header: ${filename}`)
    }
    const jsonLen = prefix.readUInt32LE(12)
    // The header pickle carries padding, so the data base is the pickle size + 8.
    const base = 8 + prefix.readUInt32LE(4)
    if (jsonLen > base - prefix.length || base > size) {
      throw new Error(`invalid ASAR header: ${filename}`)
    }
    const json = Buffer.alloc(jsonLen)
    if (readSync(fd, json, 0, jsonLen, prefix.length) !== jsonLen) {
      throw new Error(`truncated ASAR header JSON: ${filename}`)
    }
    const header = JSON.parse(json.toString('utf8'))
    const entry = header.files?.lib?.files?.['main.js']
    if (!entry || entry.unpacked) throw new Error(`packed lib/main.js missing: ${filename}`)
    const offset = Number(entry.offset)
    if (!Number.isSafeInteger(offset) || offset < 0 || entry.size > size - base - offset) {
      throw new Error(`lib/main.js is outside the ASAR data: ${filename}`)
    }
    const bytes = Buffer.alloc(entry.size)
    if (readSync(fd, bytes, 0, bytes.length, base + offset) !== bytes.length || hash(bytes) !== entry.integrity?.hash) {
      throw new Error(`lib/main.js failed ASAR integrity verification: ${filename}`)
    }
    return { size, base, jsonLen, header, entry, bytes }
  } finally {
    closeSync(fd)
  }
}

/**
 * Reads `package.json` from an archive header without loading the whole file.
 * Used as a fallback when the host cannot read inside an ASAR through its own
 * filesystem layer.
 */
export function readArchiveVersion(filename) {
  const fd = openSync(filename, 'r')
  try {
    const prefix = Buffer.alloc(16)
    if (readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length) throw new Error('truncated header')
    const jsonLen = prefix.readUInt32LE(12)
    const base = 8 + prefix.readUInt32LE(4)
    const json = Buffer.alloc(jsonLen)
    if (readSync(fd, json, 0, jsonLen, prefix.length) !== jsonLen) throw new Error('truncated header JSON')
    const header = JSON.parse(json.toString('utf8'))
    const entry = header.files?.['package.json']
    if (!entry || entry.unpacked) throw new Error('package.json is not packed')
    const bytes = Buffer.alloc(entry.size)
    if (readSync(fd, bytes, 0, bytes.length, base + Number(entry.offset)) !== bytes.length) {
      throw new Error('truncated package.json')
    }
    const parsed = JSON.parse(bytes.toString('utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : null
  } finally {
    closeSync(fd)
  }
}

/**
 * Writes a patched copy of `src` to `out`.
 *
 * @returns {{alreadyPatched: true} | {alreadyPatched: false, out: string, outSize: number,
 *   srcSize: number, sha: string, added: string[]}}
 */
export function buildPatchedArchive(src, out) {
  const { size: srcSize, base, jsonLen, header, entry, bytes } = readMainArchive(src)
  const oldSize = entry.size
  const oldOffset = Number(entry.offset)
  let text = bytes.toString('utf8')

  const hasRestart = text.includes(RESTART_MARKER)
  const hasQuit = text.includes(QUIT_MARKER)
  if (hasRestart && hasQuit) return { alreadyPatched: true }

  const added = []
  if (!hasRestart && !hasQuit) {
    const at = text.indexOf(TRAY_ANCHOR)
    if (at < 0) throw new Error('tray guard anchor not found; refusing to patch an unknown layout')
    const insertAt = at + TRAY_ANCHOR.length
    text = text.slice(0, insertAt) + '\n' + RESTART_BLOCK + '\n' + QUIT_BLOCK + text.slice(insertAt)
    added.push('restart-poller', 'quit-poller')
  } else if (hasRestart && !hasQuit) {
    const at = text.indexOf('console.warn("dsh-restart: request poll failed", error);')
    const closeMarker = '\n\t\t}, 1000);\n\t}\n'
    const closeAt = text.indexOf(closeMarker, at)
    if (at < 0 || closeAt < 0) throw new Error('legacy restart poller end not found')
    const insertAt = closeAt + closeMarker.length
    text = text.slice(0, insertAt) + '\n' + QUIT_BLOCK + text.slice(insertAt)
    added.push('quit-poller')
  } else {
    throw new Error('quit poller without restart poller; refusing to patch an unknown layout')
  }

  const mainNew = Buffer.from(text, 'utf8')
  const newSize = mainNew.length
  const newOffsetAbs = Math.ceil(srcSize / 4) * 4
  const newOffset = newOffsetAbs - base

  entry.size = newSize
  entry.offset = String(newOffset)
  entry.integrity.hash = hash(mainNew)
  entry.integrity.blocks = []
  const { blockSize } = entry.integrity
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error('invalid ASAR integrity block size')
  for (let offset = 0; offset < newSize; offset += blockSize) {
    entry.integrity.blocks.push(hash(mainNew.subarray(offset, offset + blockSize)))
  }

  const newJson = Buffer.from(JSON.stringify(header), 'utf8')
  if (newJson.length > jsonLen) throw new Error('patched ASAR header does not fit')
  const padded = Buffer.alloc(jsonLen, 0x20)
  newJson.copy(padded)

  const staged = `${out}.tmp`
  try {
    copyFileSync(src, staged)
    const fd = openSync(staged, 'r+')
    try {
      writeSync(fd, padded, 0, jsonLen, 16)
      writeSync(fd, mainNew, 0, mainNew.length, newOffsetAbs)
    } finally {
      closeSync(fd)
    }
    if (!readMainArchive(staged).bytes.equals(mainNew)) {
      throw new Error('the generated ASAR does not contain the patched script')
    }
    renameSync(staged, out)
  } finally {
    rmSync(staged, { force: true })
  }

  return {
    alreadyPatched: false,
    out,
    outSize: mainNew.length + newOffsetAbs,
    srcSize,
    sha: hash(mainNew),
    added,
    main: { oldSize, newSize, oldOffset, newOffset },
  }
}

export const PATCH_MARKERS = { restart: RESTART_MARKER, quit: QUIT_MARKER }
