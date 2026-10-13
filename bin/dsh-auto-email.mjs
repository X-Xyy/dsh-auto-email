#!/usr/bin/env node
/**
 * dsh-auto-email — command line entry point.
 *
 * Exists for three reasons: it lets a new user try the pipeline before wiring it
 * into DSH; it is what a systemd unit / Task Scheduler job calls; and it is the
 * fastest way to reproduce a bug report from the log a user pastes in.
 *
 * It is a thin shell over `lib/service.js` on purpose — the schedule, the
 * idempotence gate and the state file behave exactly as they do inside DSH, so a
 * green CLI run is real evidence.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { DEFAULTS, validate } from '../lib/config.js'
import { createService } from '../lib/service.js'
import { mergeMigratedState, migrateLegacyState, saveState } from '../lib/state.js'

const USAGE = `dsh-auto-email — 每天把当天最重要的 AI 动态（三条）发到邮箱

用法： node bin/dsh-auto-email.mjs [选项]

选项：
  --config <file>   额外的 JSON 配置覆盖（形如 { "email": { "to": ["a@b.c"] } }）
  --dry-run         只生成预览，不发信、不写状态、不动归档（安全）
  --if-due          幂等模式：未到设定时刻、或今天已发过，就直接退出 0
  --hours <N>       覆盖主时间窗（小时）
  --top <N>         覆盖精选条数（默认 3）
  --no-llm          跳过 LLM 排序与解读（用于离线自检流水线）
  --ignore-seen     忽略跨天去重（重发同一批内容）
  --migrate <file>  把 Python 版 seen.json 的跨天去重记录并入本插件状态库
  --status          只打印当前状态与配置问题，不做任何抓取
  --send-test       只做 SMTP 登录验证，不发信
  -h, --help        显示本帮助

退出码： 0 成功（含 --if-due 主动跳过） / 1 失败 / 2 配置不完整

凭据（DeepSeek API Key 与 QQ 邮箱 SMTP 授权码）从
  <userData>/dsh-auto-email.secret.json
或环境变量 DEEPSEEK_API_KEY 读取，不接受命令行传参——命令行会留在 shell 历史里。
`

/** Parse `--flag` / `--key value` / `--key=value` into a plain object. */
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('-')) { out._.push(token); continue }
    const [rawKey, inline] = token.replace(/^--?/, '').split(/=(.*)/s)
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const wantsValue = ['config', 'hours', 'top', 'migrate'].includes(rawKey)
    if (wantsValue && inline === undefined) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${token} 需要一个值`)
      out[key] = next
      i += 1
    } else {
      out[key] = inline === undefined ? true : inline
    }
  }
  return out
}

async function readConfigOverlay(file) {
  if (!file) return {}
  const abs = path.resolve(file)
  const raw = await fsp.readFile(abs, 'utf8')
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${abs} 必须是一个 JSON 对象`)
  return parsed
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String(error.message))
    console.error(USAGE)
    return 2
  }

  if (args.help || args.h) { console.log(USAGE); return 0 }

  const verbose = Boolean(args.v || args.verbose)
  let options
  try {
    options = await readConfigOverlay(args.config)
  } catch (error) {
    console.error(`读取 --config 失败：${String(error?.message ?? error)}`)
    return 2
  }

  // Log to stdout with a timestamp: this is what ends up in a user's issue.
  const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
  const logger = {
    info: (msg) => console.log(`[${ts()}] ${msg}`),
    warn: (msg) => console.warn(`[${ts()}] WARN ${msg}`),
    error: (msg) => console.error(`[${ts()}] ERROR ${msg}`),
  }

  const service = await createService({ options, logger })
  const cfg = service.cfg

  if (args.status || args.sendTest) {
    const status = service.getStatus()
    console.log(JSON.stringify(status, null, 2))
    if (args.sendTest) {
      const { verifySmtp } = await import('../lib/mail.js')
      const problems = validate(cfg)
      if (problems.length) {
        console.error(`配置不完整：\n  - ${problems.join('\n  - ')}`)
        return 2
      }
      logger.info('正在验证 SMTP 登录…')
      await verifySmtp(cfg.email, logger)
      logger.info('SMTP 登录成功。')
    }
    return 0
  }

  if (args.migrate) return migrate(service, String(args.migrate), logger)

  if (args.ifDue) {
    const outcome = await service.runIfDue()
    if (!outcome.ran) {
      logger.info(`--if-due：本次跳过（${translateReason(outcome.reason)}）`)
      if (outcome.reason === 'error') return 1
      return 0
    }
    return 0
  }

  const problems = validate(cfg)
  const willSend = !args.dryRun
  if (willSend && problems.length) {
    console.error(`配置不完整，无法发送：\n  - ${problems.join('\n  - ')}`)
    console.error('\n先运行 `node bin/dsh-auto-email.mjs --status` 查看，再补齐密钥文件。')
    return 2
  }
  if (problems.length) logger.warn(`配置不完整（--dry-run 下仍会继续）：${problems.join('；')}`)

  const result = await service.runOnce({
    dryRun: Boolean(args.dryRun),
    hours: args.hours === undefined ? null : Number(args.hours),
    topN: args.top === undefined ? null : Number(args.top),
    noLlm: Boolean(args.noLlm),
    ignoreSeen: Boolean(args.ignoreSeen),
    log: (msg) => logger.info(msg),
  })

  if (verbose) {
    console.log(`\n数据目录： ${cfg.paths.dataDir}`)
    if (result.picked?.length) {
      for (const item of result.picked) {
        console.log(`  · [${item.extra?.topic ?? '?'}] ${item.extra?.headline ?? item.title}  (${item.source_name})`)
      }
    }
  }
  return 0
}

/** Turn an internal reason code into something a user can read. */
function translateReason(reason) {
  return {
    disabled: '调度已关闭',
    'already-sent': '今天已经投递过',
    'before-time': `还没到推送时刻（设定为 ${DEFAULTS.schedule.time}）`,
    'too-late': '已超出补发窗口',
    due: '应当运行',
  }[reason] ?? reason
}

/**
 * `--migrate <seen.json>`: fold the Python build's cross-day dedupe memory into
 * this plugin's state file.
 *
 * Written as a union that can only ever *grow* the memory and only ever move the
 * idempotence gate *forwards*. Getting either backwards would re-send a digest
 * the user already read, which is the one failure a migration must not cause.
 * Idempotent: running it twice reports zero additions the second time.
 *
 * @returns {Promise<number>} process exit code.
 */
async function migrate(service, file, logger) {
  const source = path.resolve(file)
  const target = path.resolve(service.cfg.paths.stateFile)
  if (source === target) {
    console.error('--migrate：源文件与目标状态文件是同一个，拒绝原地迁移。')
    return 2
  }

  let raw
  try {
    raw = await fsp.readFile(source, 'utf8')
  } catch (error) {
    console.error(`--migrate：读不到 ${source}（${error?.code ?? error?.message}）`)
    return 2
  }

  const legacy = migrateLegacyState(raw)
  if (!legacy) {
    console.error(`--migrate：${source} 不是 Python 版 seen.json 的形状（顶层缺少 "sent" 对象）。`)
    return 2
  }

  // Back up the target before touching it: a botched merge is recoverable from
  // the .bak, but a clobbered dedupe memory is not.
  let backup = ''
  try {
    await fsp.access(target)
    backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await fsp.copyFile(target, backup)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const merged = mergeMigratedState(service.state, legacy)
  await saveState(target, service.state, logger)

  logger.info(`--migrate：从 ${source} 读取 ${legacy.migrated} 条去重记录`)
  logger.info(`--migrate：新增 ${merged.added} 条，已存在 ${merged.kept} 条，现共 ${Object.keys(service.state.seen).length} 条`)
  logger.info(`--migrate：幂等闸门 last_sent_date = ${merged.lastSentDate || '(空)'}${merged.tookLastSent ? '（取自旧文件）' : '（保留原值，不动）'}`)
  logger.info(`--migrate：已写入 ${target}`)
  if (backup) logger.info(`--migrate：原状态已备份到 ${backup}`)
  logger.info('--migrate：未发送任何邮件，未改动归档。')
  return 0
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    console.error(`\n运行失败：${String(error?.stack ?? error)}`)
    process.exitCode = 1
  },
)
