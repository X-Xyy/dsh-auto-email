/**
 * dsh-auto-email — the runtime service.
 *
 * Everything the plugin actually does lives here, deliberately free of any DSH
 * API so it can be exercised by plain `node`: resolve configuration, load state,
 * decide whether a scheduled run is due, run the pipeline, deliver, and persist.
 * `lib/plugin.js` is then only wiring.
 *
 * Time handling note: "today" and the schedule target are always computed in the
 * configured IANA zone, never the host machine's zone. The offset is derived from
 * `Intl` rather than hard-coded, so a zone with DST would still land on the right
 * wall-clock minute on most days; `Asia/Shanghai` has no DST at all.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { mergeDeep, readSecretFile, resolveConfig, secretFilePath, userDataDir, validate, DATA_DIR_NAME } from './config.js'
import { sendMail, verifySmtp } from './mail.js'
import { runDigest } from './pipeline.js'
import { hashTitle, loadState, markDelivered, markFailure, saveState } from './state.js'
import { norm_title } from './digest.js'

/** Wall-clock fields of `date` as seen in `timeZone`. */
function tzParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/** Minutes east of UTC that `timeZone` was at `date`. */
function tzOffsetMinutes(date, timeZone) {
  const p = tzParts(date, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asIfUtc - date.getTime()) / 60_000)
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads `hh:mm` on the same
 * calendar day as `reference`.
 *
 * @param {Date} reference - any instant on the target day.
 * @param {string} timeZone
 * @param {string} hhmm - `HH:MM`.
 * @returns {Date}
 */
export function zonedTargetInstant(reference, timeZone, hhmm) {
  const [hour, minute] = String(hhmm).split(':').map(Number)
  const p = tzParts(reference, timeZone)
  // First guess: treat the wall-clock time as if it were UTC, then subtract the
  // zone offset measured at that guess (which is the offset actually in force).
  const guess = Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0)
  const offset = tzOffsetMinutes(new Date(guess), timeZone)
  return new Date(guess - offset * 60_000)
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** `YYYY-MM-DD HH:MM:SS` of `date` in `timeZone`. */
export function stamp(date, timeZone) {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
  return `${dayKey(date, timeZone)} ${clock}`
}

/** Keys a user may set from the panel; anything else is ignored on write. */
const WRITABLE_KEYS = new Set([
  'dataDir',
  'llm.base_url', 'llm.model', 'llm.timeoutMs',
  'digest.top_n', 'digest.window_hours', 'digest.min_importance', 'digest.send_when_empty',
  'digest.max_candidates_for_ranking', 'digest.arxiv_max_items', 'digest.hn_max_items',
  'email.smtp_host', 'email.smtp_port', 'email.use_ssl', 'email.username', 'email.from_name',
  'email.to', 'email.timezone',
  'schedule.enabled', 'schedule.time', 'schedule.catch_up_hours', 'schedule.timezone',
])

/** Set `obj[a.b.c] = value` for a dotted path. */
function setPath(obj, dotted, value) {
  const segments = dotted.split('.')
  let cursor = obj
  for (const segment of segments.slice(0, -1)) {
    if (typeof cursor[segment] !== 'object' || cursor[segment] === null) cursor[segment] = {}
    cursor = cursor[segment]
  }
  cursor[segments[segments.length - 1]] = value
}

/**
 * Create the service. Configuration is layered
 * `DEFAULTS < plugin options < panel config.json < secrets`, and `dataDir` is
 * deliberately taken from the plugin options only — letting the panel move the
 * data directory would mean the panel's own file had to be read to find it.
 *
 * @param {object} [deps]
 * @param {object} [deps.options] - plugin options from `cordis.patch.yml`.
 * @param {object} [deps.logger] - `{ info, warn, error }`; defaults to a no-op.
 * @returns {Promise<object>} the service.
 */
export async function createService(deps = {}) {
  const logger = deps.logger ?? {}
  const options = deps.options ?? {}

  const baseDataDir = String(options.dataDir ?? '').trim() === ''
    ? path.join(userDataDir(), DATA_DIR_NAME)
    : path.resolve(String(options.dataDir))
  const panelConfigFile = path.join(baseDataDir, 'config.json')

  let inFlight = null
  let lastOutcome = null
  let timer = null
  let cfg = null
  let state = null

  /** Read the panel-written overrides; a missing file is normal. */
  const loadOverrides = async () => {
    try {
      const raw = await fsp.readFile(panelConfigFile, 'utf8')
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn?.(`dsh-auto-email: 忽略无法解析的 ${panelConfigFile}：${error?.message ?? error}`)
      return {}
    }
  }

  const refresh = async () => {
    const overrides = await loadOverrides()
    cfg = await resolveConfig(mergeDeep(options, overrides), { logger, secret: deps.secret })
    state = deps.state ?? (await loadState(cfg.paths.stateFile, logger))
    return cfg
  }

  await refresh()

  /** The instant today's schedule target falls on, in the configured zone. */
  const targetFor = (now = new Date()) => zonedTargetInstant(now, cfg.schedule.timezone || cfg.email.timezone, cfg.schedule.time)

  /** When the next run is expected, as an ISO string and in zone-local terms. */
  const nextRunAt = (now = new Date()) => {
    const target = targetFor(now)
    if (target.getTime() > now.getTime()) return target
    // Already past today's target: the next attempt is tomorrow's. Add 24h to the
    // wall clock by re-deriving from tomorrow's date, which keeps DST sane.
    return zonedTargetInstant(new Date(target.getTime() + 86_400_000), cfg.schedule.timezone || cfg.email.timezone, cfg.schedule.time)
  }

  /**
   * Should a scheduled run fire right now?
   *
   * Four independent reasons to decline, each reported so the panel can explain
   * itself instead of silently doing nothing.
   *
   * @param {Date} [now]
   * @returns {{ due: boolean, reason: string, target: Date }}
   */
  const isDue = (now = new Date()) => {
    const target = targetFor(now)
    if (!cfg.schedule.enabled) return { due: false, reason: 'disabled', target }
    if (state.last_sent_date === dayKey(now, cfg.email.timezone)) return { due: false, reason: 'already-sent', target }
    if (now.getTime() < target.getTime()) return { due: false, reason: 'before-time', target }
    const catchUpMs = (Number(cfg.schedule.catch_up_hours) || 0) * 3_600_000
    if (catchUpMs > 0 && now.getTime() - target.getTime() > catchUpMs) {
      return { due: false, reason: 'too-late', target }
    }
    return { due: true, reason: 'due', target }
  }

  /**
   * Run the pipeline, and unless this is a dry run, deliver and record it.
   *
   * @param {object} [runOptions]
   * @param {boolean} [runOptions.dryRun]
   * @param {number|null} [runOptions.hours]
   * @param {number|null} [runOptions.topN]
   * @param {boolean} [runOptions.ignoreSeen]
   * @param {boolean} [runOptions.noLlm]
   * @param {boolean} [runOptions.skipSend]
   * @param {(msg: string) => void} [runOptions.log]
   * @returns {Promise<object>} the run result plus `{ sent, skipped, mail }`.
   */
  const runOnce = async (runOptions = {}) => {
    if (inFlight) throw new Error('已有一次运行正在进行中，请等待它完成')
    const log = runOptions.log ?? (() => {})
    const dryRun = Boolean(runOptions.dryRun)

    const execute = async () => {
      await refresh()
      const now = new Date()
      const problems = validate(cfg)
      if (problems.length > 0 && !dryRun && !runOptions.skipSend) {
        throw new Error(`配置不完整：${problems.join('；')}`)
      }

      const result = await runDigest(cfg, {
        log,
        dryRun,
        hours: runOptions.hours,
        topN: runOptions.topN,
        ignoreSeen: runOptions.ignoreSeen,
        noLlm: runOptions.noLlm,
      })

      if (dryRun || runOptions.skipSend) {
        return { ...result, sent: false, skipped: dryRun ? 'dry-run' : 'skip-send', mail: null }
      }

      if (result.picked.length === 0 && cfg.digest.send_when_empty === false) {
        log('当日无候选条目，且 send_when_empty=false，本次不发送。')
        markFailure(state, '当日无候选条目', { date: result.meta.date })
        await saveState(cfg.paths.stateFile, state, logger)
        return { ...result, sent: false, skipped: 'empty', mail: null }
      }

      try {
        const mail = await sendMail(cfg.email, {
          subject: result.subject,
          text: result.text,
          html: result.html,
          date: now,
          timeZone: cfg.email.timezone,
        }, logger)
        markDelivered(state, result.picked.map((item) => hashTitle(norm_title(item.title))), result.meta.date, {
          at: stamp(now, cfg.email.timezone),
          sent: true,
          picked: result.picked.length,
        })
        await saveState(cfg.paths.stateFile, state, logger)
        log(`完成。主题：${result.subject}`)
        return { ...result, sent: true, skipped: '', mail }
      } catch (error) {
        log(`邮件投递最终失败：${String(error?.message ?? error).slice(0, 300)}`)
        log(`HTML 已保存在 ${path.join(cfg.paths.archiveDir, result.meta.date)}.html，可手动补发`)
        markFailure(state, String(error?.message ?? error).slice(0, 300), { date: result.meta.date })
        await saveState(cfg.paths.stateFile, state, logger)
        throw error
      }
    }

    inFlight = execute().finally(() => { inFlight = null })
    return inFlight
  }

  /**
   * Kick off a run without waiting for it.
   *
   * A digest run takes minutes, which is far too long to hold an HTTP request
   * open, so the panel starts one and then polls `getStatus()`. The outcome is
   * recorded on `lastOutcome` for that polling to pick up.
   *
   * @param {object} [runOptions] - same shape as `runOnce`.
   * @returns {{ started: boolean, reason?: string, promise?: Promise<object> }}
   */
  const beginRun = (runOptions = {}) => {
    if (inFlight) return { started: false, reason: 'busy' }
    const promise = runOnce(runOptions).then(
      (result) => {
        lastOutcome = {
          at: stamp(new Date(), cfg.email.timezone),
          ok: true,
          subject: result.subject,
          date: result.meta.date,
          sent: Boolean(result.sent),
          skipped: result.skipped ?? '',
          stories: result.stories,
          error: '',
        }
        return result
      },
      (error) => {
        lastOutcome = {
          at: stamp(new Date(), cfg.email.timezone),
          ok: false,
          subject: '',
          date: '',
          sent: false,
          skipped: '',
          stories: [],
          error: String(error?.message ?? error).slice(0, 300),
        }
        throw error
      },
    )
    // The panel only polls `lastOutcome`; keep the rejection from going unhandled.
    promise.catch(() => {})
    return { started: true, promise }
  }

  /**
   * Run only if `isDue`, used by the timer. Never throws: a scheduled failure
   * belongs in the log and the panel, not in an unhandled rejection.
   *
   * @param {Date} [now]
   * @returns {Promise<{ ran: boolean, reason: string, result?: object, error?: string }>}
   */
  const runIfDue = async (now = new Date()) => {
    const due = isDue(now)
    if (!due.due) return { ran: false, reason: due.reason }
    // A digest run takes minutes, and `last_sent_date` only moves once it
    // finishes — so every tick in between still sees `due`. Without this guard
    // each of those ticks called runOnce(), hit the inFlight check, and logged
    //   error dsh-auto-email: dsh-auto-email: 定时运行失败：已有一次运行正在进行中
    // four times per run (observed live at tick_seconds=30). "Busy" is the
    // correct answer here, not a failure.
    if (inFlight) return { ran: false, reason: 'busy' }
    try {
      const result = await runOnce({ log: (msg) => logger.info?.(`[定时] ${msg}`) })
      return { ran: true, reason: 'due', result }
    } catch (error) {
      logger.error?.(`dsh-auto-email: 定时运行失败：${String(error?.message ?? error)}`)
      return { ran: false, reason: 'error', error: String(error?.message ?? error) }
    }
  }

  /**
   * Persist panel-edited configuration. Only whitelisted keys are honoured, and
   * secrets are never written here.
   *
   * @param {object} patch - dotted keys, e.g. `{ 'digest.top_n': 5 }`.
   * @returns {Promise<{ saved: string[], ignored: string[] }>}
   */
  const saveConfig = async (patch = {}) => {
    const overrides = await loadOverrides()
    const saved = []
    const ignored = []
    for (const [key, value] of Object.entries(patch)) {
      if (!WRITABLE_KEYS.has(key)) { ignored.push(key); continue }
      setPath(overrides, key, value)
      saved.push(key)
    }
    await fsp.mkdir(baseDataDir, { recursive: true })
    await fsp.writeFile(panelConfigFile, JSON.stringify(overrides, null, 2), 'utf8')
    await refresh()
    return { saved, ignored }
  }

  /**
   * Write secrets to their own file, created with owner-only permissions. Kept
   * apart from `config.json` so that a config file the user might paste into an
   * issue never carries a key.
   *
   * @param {object} patch - `{ deepseek_api_key?, smtp_auth_code?, smtp_username?, recipients? }`.
   * @returns {Promise<{ saved: string[] }>}
   */
  const saveSecret = async (patch = {}) => {
    const file = secretFilePath()
    const existing = await readSecretFile(file, logger)
    const allowed = ['deepseek_api_key', 'smtp_auth_code', 'smtp_username', 'recipients']
    const saved = []
    for (const key of allowed) {
      if (patch[key] !== undefined) { existing[key] = patch[key]; saved.push(key) }
    }
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, JSON.stringify(existing, null, 2), { encoding: 'utf8', mode: 0o600 })
    await refresh()
    return { saved }
  }

  /**
   * A snapshot for the panel and the status tool. Secrets are reduced to booleans.
   *
   * @param {Date} [now]
   * @returns {object}
   */
  const getStatus = (now = new Date()) => {
    const due = isDue(now)
    const next = nextRunAt(now)
    return {
      name: 'dsh-auto-email',
      enabled: cfg.schedule.enabled,
      due: due.due,
      due_reason: due.reason,
      target_today: stamp(due.target, cfg.email.timezone),
      next_run_at: stamp(next, cfg.email.timezone),
      schedule: { time: cfg.schedule.time, timezone: cfg.schedule.timezone, catch_up_hours: cfg.schedule.catch_up_hours, tick_seconds: cfg.schedule.tick_seconds },
      problems: validate(cfg),
      llm: { base_url: cfg.llm.base_url, model: cfg.llm.model, api_key_set: Boolean(cfg.llm.api_key) },
      email: {
        smtp_host: cfg.email.smtp_host,
        smtp_port: cfg.email.smtp_port,
        use_ssl: cfg.email.use_ssl,
        username: cfg.email.username,
        from_name: cfg.email.from_name,
        to: cfg.email.to,
        auth_code_set: Boolean(cfg.email.auth_code),
        timezone: cfg.email.timezone,
      },
      digest: { ...cfg.digest },
      paths: { ...cfg.paths, secretFile: cfg.secretFile },
      state: {
        last_sent_date: state.last_sent_date,
        last_sent_at: state.last_sent_at,
        last_run: state.last_run,
        last_error: state.last_error,
        seen_count: Object.keys(state.seen ?? {}).length,
        recent_runs: (state.runs ?? []).slice(0, 8),
      },
      running: Boolean(inFlight),
      last_outcome: lastOutcome,
    }
  }

  /** Start the due-check timer. Idempotent. */
  const start = () => {
    if (timer) return
    const period = Math.max(5, Number(cfg.schedule.tick_seconds) || 30) * 1_000
    const tick = () => { runIfDue().catch((error) => logger.error?.(`dsh-auto-email: tick 失败 ${error?.message ?? error}`)) }
    // Check once shortly after start so opening DSH after a missed morning still
    // catches up, then settle into the configured cadence.
    timer = setTimeout(function loop() {
      tick()
      timer = setTimeout(loop, period)
    }, 5_000)
    if (typeof timer.unref === 'function') timer.unref()
    timer.__dshAutoEmail = true
  }

  /** Stop the timer. Idempotent. */
  const stop = () => {
    if (timer) { clearTimeout(timer); timer = null }
  }

  return {
    get cfg() { return cfg },
    get state() { return state },
    refresh,
    runOnce,
    beginRun,
    runIfDue,
    isDue,
    nextRunAt,
    targetFor,
    saveConfig,
    saveSecret,
    getStatus,
    verifySmtp: () => verifySmtp(cfg.email),
    start,
    stop,
  }
}
