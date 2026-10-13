/**
 * dsh-auto-email — configuration: defaults, the secret file, and path resolution.
 *
 * Three layers feed the runtime config, later ones winning:
 *   1. `DEFAULTS` below
 *   2. the plugin options the user wrote in `profiles/<profile>/cordis.patch.yml`
 *   3. secrets, which never belong in that file: `<userData>/dsh-auto-email.secret.json`
 *      and, failing that, the DSH credential store or the environment.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Secret file name, looked up next to the DSH harness directory. */
export const SECRET_FILE_NAME = 'dsh-auto-email.secret.json'

/** Default data directory name, under the DSH user-data root. */
export const DATA_DIR_NAME = 'dsh-auto-email'

/**
 * Baseline configuration. These are the values a fresh install runs with, and
 * they are the same numbers the reference Python implementation shipped with
 * (`ai-daily-digest/config.local.json`), so behaviour does not change just
 * because the language did.
 */
export const DEFAULTS = {
  /** Absolute data directory; `''` means "derive from the DSH user-data root". */
  dataDir: '',

  llm: {
    base_url: 'https://api.deepseek.com',
    api_key: '',
    model: 'deepseek-chat',
    /** Per-request ceiling. Ranking a full pool takes a while; be patient. */
    timeoutMs: 180_000,
  },

  digest: {
    /** How many stories one email carries. */
    top_n: 3,
    /** Primary look-back window, in hours. */
    window_hours: 26,
    /** Progressively wider windows, tried in order when the primary is too thin. */
    fallback_window_hours: [48, 72],
    /** An item must reach this importance before it may be picked. */
    min_importance: 6,
    /** Hard cap on how many items are sent to the LLM for ranking in one run. */
    max_candidates_for_ranking: 90,
    arxiv_max_items: 22,
    hn_max_items: 30,
    /** Send even when today's pool turned up nothing. */
    send_when_empty: true,
    /** How many summary-less items to backfill by fetching their page. */
    backfill_thin: 14,
    /** Summaries shorter than this are treated as missing. */
    brief_max_chars: 40,
  },

  email: {
    // Key names follow the reference config (`ai-daily-digest/config.local.json`)
    // rather than SMTP library conventions, so the two files stay diffable.
    smtp_host: 'smtp.qq.com',
    smtp_port: 465,
    /** `true` for implicit TLS (465), `false` for STARTTLS (587). */
    use_ssl: true,
    /** The sending account; also the envelope sender. */
    username: '',
    /** SMTP authorization code — QQ Mail has no password login. */
    auth_code: '',
    from_name: 'AI 每日三报',
    /** One address or several. */
    to: [],
    timezone: 'Asia/Shanghai',
    timeoutMs: 45_000,
  },

  schedule: {
    enabled: true,
    /** Local wall-clock time in `timezone`, `HH:MM`. */
    time: '08:00',
    /**
     * How many hours past `time` a missed run may still fire. A whole night
     * asleep is normal; three days asleep is not a catch-up, it is a stale email.
     */
    catch_up_hours: 12,
    timezone: 'Asia/Shanghai',
    /** How often the host checks whether a run is due. */
    tick_seconds: 30,
  },

  log: { level: 'info' },
}

/** Deep-merge plain objects; arrays and scalars are replaced wholesale. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {object} base
 * @param {object} override
 * @returns {object} a new merged object; neither input is mutated.
 */
export function mergeDeep(base, override) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? mergeDeep(base[key], value) : value
  }
  return out
}

/**
 * The DSH user-data root: the parent of `DSH_HOME` when the harness exports it,
 * otherwise three levels up from this file (the layout `plugins/<name>/lib/*.js`).
 *
 * @returns {string} absolute directory.
 */
export function userDataDir() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return path.dirname(path.resolve(home))
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/** @returns {string} absolute path of the secret file. */
export function secretFilePath() {
  return path.join(userDataDir(), SECRET_FILE_NAME)
}

/**
 * Read the secret file. A missing or malformed file is not an error — it just
 * means the plugin falls back to the credential store or the environment.
 *
 * @param {string} file - absolute path.
 * @param {object} [logger] - optional `{ warn }`.
 * @returns {Promise<object>} the parsed object, or `{}`.
 */
export async function readSecretFile(file, logger) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return isPlainObject(parsed) ? parsed : {}
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.(`dsh-auto-email: ignoring unreadable secret file ${file}: ${error?.message ?? error}`)
    return {}
  }
}

/** Turn a string, `null`, or an array into a clean array of strings. */
function toAddressList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
  const single = String(value ?? '').trim()
  return single === '' ? [] : [single]
}

/**
 * Build the effective configuration.
 *
 * @param {object} [options] - plugin options from `cordis.patch.yml`.
 * @param {object} [deps] - `{ logger, secret }`; `secret` skips the file read
 *   (used by tests, and by the host half once it has consulted the vault).
 * @returns {Promise<object>} the resolved config, with absolute paths added.
 */
export async function resolveConfig(options = {}, deps = {}) {
  const { logger, secret: injectedSecret } = deps
  const secretFile = secretFilePath()
  const secret = injectedSecret ?? (await readSecretFile(secretFile, logger))

  const merged = mergeDeep(DEFAULTS, options)

  // Secrets: explicit option, then the secret file, then the environment.
  const envKey = String(process.env.DEEPSEEK_API_KEY ?? '').trim()
  merged.llm.api_key = String(
    merged.llm.api_key || secret.deepseek_api_key || secret.api_key || envKey || '',
  ).trim()
  merged.email.auth_code = String(merged.email.auth_code || secret.smtp_auth_code || '').trim()
  merged.email.username = String(merged.email.username || secret.smtp_username || '').trim()

  const dataDir = String(merged.dataDir || '').trim() === ''
    ? path.join(userDataDir(), DATA_DIR_NAME)
    : path.resolve(String(merged.dataDir))

  const email = merged.email
  // The default `to: []` is "unset", not "send to nobody", so an empty list must
  // still fall through to the secret file's `recipients`.
  const explicitTo = toAddressList(email.to)
  email.to = explicitTo.length > 0 ? explicitTo : toAddressList(secret.recipients)
  email.smtp_host = String(email.smtp_host).trim()
  email.smtp_port = Number(email.smtp_port) || 465
  email.use_ssl = email.use_ssl !== false

  // `HH:MM` in 24-hour form; anything else falls back to the default rather than
  // arming a timer that would never fire.
  const rawTime = String(merged.schedule.time ?? '').trim()
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(rawTime)) {
    if (rawTime !== '') logger?.warn?.(`dsh-auto-email: schedule.time "${rawTime}" is not HH:MM; using ${DEFAULTS.schedule.time}`)
    merged.schedule.time = DEFAULTS.schedule.time
  }

  merged.digest.fallback_window_hours = (Array.isArray(merged.digest.fallback_window_hours)
    ? merged.digest.fallback_window_hours
    : [merged.digest.fallback_window_hours]
  ).map(Number).filter((n) => Number.isFinite(n) && n > 0)

  return {
    ...merged,
    dataDir,
    secretFile,
    paths: {
      dataDir,
      archiveDir: path.join(dataDir, 'archive'),
      logDir: path.join(dataDir, 'logs'),
      stateFile: path.join(dataDir, 'state.json'),
      configFile: path.join(dataDir, 'config.json'),
      previewDir: path.join(dataDir, 'preview'),
    },
  }
}

/**
 * Report what is missing before a send could work. Returning a list rather than
 * throwing lets the panel show every problem at once instead of one per attempt.
 *
 * @param {object} cfg - resolved config.
 * @returns {string[]} human-readable problems; empty when the config is usable.
 */
export function validate(cfg) {
  const problems = []
  if (!cfg.llm.api_key) problems.push('未配置 DeepSeek API Key（llm.api_key 或密钥文件 deepseek_api_key）')
  if (!cfg.email.username) problems.push('未配置发件邮箱账号（email.username）')
  if (!cfg.email.auth_code) problems.push('未配置 SMTP 授权码（email.auth_code 或密钥文件 smtp_auth_code）')
  if (!cfg.email.smtp_host) problems.push('未配置 SMTP 服务器（email.smtp_host）')
  if (!Array.isArray(cfg.email.to) || cfg.email.to.length === 0) problems.push('未配置收件人（email.to）')
  return problems
}
