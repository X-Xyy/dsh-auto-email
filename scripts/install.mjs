#!/usr/bin/env node
/**
 * dsh-auto-email — install / uninstall helper for the DSH Desktop plugin host.
 *
 * Two independent steps, each opt-in so nothing happens by surprise:
 *   1. copy `package.json` + `lib/` into the DSH user plugin directory;
 *   2. optionally mount that copy in the active profile's `cordis.patch.yml`.
 *
 * The patch edit is fenced by explicit markers and is idempotent: removing
 * everything between the markers and re-adding a fresh block means running this
 * twice cannot produce a duplicate row, and `--unmount` restores the file to
 * exactly the bytes a non-participating user would have. A timestamped backup is
 * written before the first modification.
 *
 * Usage:
 *   node scripts/install.mjs                 # copy only, print the YAML to add
 *   node scripts/install.mjs --mount         # copy, then mount
 *   node scripts/install.mjs --mount --rev 2 # ... with a cache-busting rev
 *   node scripts/install.mjs --unmount       # remove the mounted row
 *   node scripts/install.mjs --dest <dir>    # copy somewhere else
 *   node scripts/install.mjs --dry-run       # print what would change
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const MARK_BEGIN = '# --- dsh-auto-email (managed by scripts/install.mjs) ---'
const MARK_END = '# --- /dsh-auto-email ---'
const PLUGIN_ID_BASE = 'dsh-auto-email'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Parse the few flags this script takes. */
function parseArgs(argv) {
  const out = { mount: false, unmount: false, dryRun: false, rev: '', dest: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--mount') out.mount = true
    else if (token === '--unmount') out.unmount = true
    else if (token === '--dry-run') out.dryRun = true
    else if (token === '--rev') { out.rev = String(argv[i + 1] ?? ''); i += 1 }
    else if (token === '--dest') { out.dest = String(argv[i + 1] ?? ''); i += 1 }
    else if (token === '-h' || token === '--help') out.help = true
    else throw new Error(`未知参数：${token}`)
  }
  return out
}

/**
 * The DSH user-data root, mirroring `lib/config.js`: the *parent* of `DSH_HOME`
 * when the harness exports it (`DSH_HOME` is the harness directory, not the data
 * root — getting this wrong writes the plugin somewhere DSH never looks), else the
 * platform default. Duplicated rather than imported so this script keeps working
 * when `lib/` is broken — it is the tool you reach for when things are broken.
 */
function dshRoot() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return path.dirname(path.resolve(home))
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-desktop')
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-desktop')
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'dsh-desktop')
}

/** Recursively copy `from` into `to`, creating `to`. */
async function copyTree(from, to) {
  await fsp.mkdir(to, { recursive: true })
  let count = 0
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) count += await copyTree(src, dst)
    else if (entry.isFile()) { await fsp.copyFile(src, dst); count += 1 }
  }
  return count
}

/** The `file:///` URL a `cordis.patch.yml` row needs. */
function fileUrl(abs) {
  const slash = abs.replace(/\\/g, '/')
  return `file:///${slash.replace(/^\//, '')}`
}

/** The YAML block this script owns, markers included. */
function mountBlock(destDir, rev) {
  const id = rev === '' ? `${PLUGIN_ID_BASE}-1` : `${PLUGIN_ID_BASE}-${rev}`
  const url = `${fileUrl(path.join(destDir, 'lib', 'index.js'))}${rev === '' ? '' : `?rev=${rev}`}`
  return [
    MARK_BEGIN,
    '# 每日 AI 三报：host 半边提供 4 个工具与 8 条路由，browser 半边提供侧边栏面板。',
    '# 在 DSH 的插件管理面板里开关本行即可启用/禁用。',
    '# 改了代码又不重启：把下面的 id 换成新的（例如 dsh-auto-email-2），dsh-hmr 才会重新导入。',
    '- insert:',
    `    - id: ${id}`,
    `      name: "${url}"`,
    MARK_END,
    '',
  ].join('\n')
}

/** Strip a previously managed block (and its trailing blank line) from `text`. */
function stripBlock(text) {
  const begin = text.indexOf(MARK_BEGIN)
  if (begin === -1) return { text, found: false }
  const endMark = text.indexOf(MARK_END, begin)
  if (endMark === -1) return { text, found: false }
  let end = endMark + MARK_END.length
  while (text[end] === '\n') end += 1
  // Also swallow the newline that ended the preceding line, so removal leaves no gap.
  let start = begin
  while (start > 0 && text[start - 1] === '\n') start -= 1
  return { text: text.slice(0, start) + (start === 0 ? '' : '\n') + text.slice(end), found: true }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(await fsp.readFile(new URL(import.meta.url), 'utf8').then((s) => s.split('*/')[0].replace(/^\/\*\*?/, '').trim()))
    return 0
  }

  const root = dshRoot()
  const destDir = args.dest ? path.resolve(args.dest) : path.join(root, 'plugins', PLUGIN_ID_BASE)
  const patchFile = path.join(root, 'harness', 'profiles', 'web', 'cordis.patch.yml')

  console.log(`仓库：      ${repoRoot}`)
  console.log(`插件目录：  ${destDir}`)
  console.log(`patch 文件：${patchFile}`)

  if (!args.unmount) {
    if (args.dryRun) {
      console.log('\n[dry-run] 会拷贝 package.json 与 lib/ 到插件目录。')
    } else {
      await fsp.rm(destDir, { recursive: true, force: true })
      await fsp.mkdir(destDir, { recursive: true })
      await fsp.copyFile(path.join(repoRoot, 'package.json'), path.join(destDir, 'package.json'))
      const n = 1 + await copyTree(path.join(repoRoot, 'lib'), path.join(destDir, 'lib'))
      console.log(`\n[OK] 已拷贝 ${n} 个文件。`)
    }
  }

  let original
  try {
    original = await fsp.readFile(patchFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.error(`\n找不到 ${patchFile}。请先用 DSH Desktop 打开过一个会话，或手动挂载：\n`)
      console.error(mountBlock(destDir, args.rev))
      return 1
    }
    throw error
  }

  const { text: stripped, found } = stripBlock(original)
  const wantBlock = args.mount && !args.unmount
  const next = wantBlock ? `${stripped.replace(/\s*$/, '')}\n\n${mountBlock(destDir, args.rev)}` : stripped

  if (next === original) {
    console.log(`\n[OK] patch 文件无变化（${found ? '已挂载' : '未挂载'}）。`)
  } else if (args.dryRun) {
    console.log(`\n[dry-run] patch 文件会${wantBlock ? '写入' : '移除'}托管区块。`)
  } else {
    const backup = `${patchFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await fsp.writeFile(backup, original, 'utf8')
    await fsp.writeFile(patchFile, next, 'utf8')
    console.log(`\n[OK] patch 文件已更新（备份：${path.basename(backup)}）。`)
    console.log('     让 DSH 重新读取：重启应用，或改动上面的 id 触发 dsh-hmr。')
  }

  if (!wantBlock && !args.unmount) {
    console.log('\n要挂载，把下面这段追加到 cordis.patch.yml 末尾（或加 --mount 让本脚本代劳）：\n')
    console.log(mountBlock(destDir, args.rev))
  }
  return 0
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    console.error(`\n安装脚本失败：${String(error?.stack ?? error)}`)
    process.exitCode = 1
  },
)
