/**
 * dsh-auto-email — durable run state: what was already sent, and how recent runs went.
 *
 * The state file is the plugin's memory. Two jobs depend on it:
 *   - cross-day de-duplication, so a slow news day does not re-send yesterday's story;
 *   - the idempotence gate, so four schedule triggers cannot produce four emails.
 *
 * It is written atomically and holds only hashes, never article bodies.
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** How long a sent-title hash is remembered before it may reappear. */
export const SEEN_RETENTION_DAYS = 90

/** How many run records to keep for the panel's history view. */
export const RUN_HISTORY_LIMIT = 30

/**
 * Title hash, mirroring the reference implementation's `h()`: the first 20 hex
 * characters of the SHA-1 of the normalized title. Kept identical so an existing
 * `seen.json` from the Python build can be migrated without re-sending anything.
 *
 * @param {string} normalizedTitle - output of `normTitle`, not a raw headline.
 * @returns {string} 20-character lowercase hex digest.
 */
export function hashTitle(normalizedTitle) {
  return crypto.createHash('sha1').update(String(normalizedTitle ?? ''), 'utf8').digest('hex').slice(0, 20)
}

/** A fresh state object. */
export function emptyState() {
  return {
    /** `{ [titleHash]: 'YYYY-MM-DD' }` — when each headline was last delivered. */
    seen: {},
    /** ISO timestamp of the last completed run, successful or not. */
    last_run: '',
    /** `YYYY-MM-DD` of the last *successful delivery*; the idempotence gate reads this. */
    last_sent_date: '',
    /** ISO timestamp of the last successful delivery. */
    last_sent_at: '',
    /** Last failure message, cleared on the next success. */
    last_error: '',
    /** Newest-first list of `{ at, date, sent, picked, error }`. */
    runs: [],
  }
}

/**
 * Read the state file, tolerating absence, a BOM, and partial corruption.
 *
 * @param {string} file - absolute path.
 * @param {object} [logger] - optional `{ warn }`.
 * @returns {Promise<object>} the state, repaired to the full shape.
 */
export async function loadState(file, logger) {
  let parsed
  try {
    const raw = await fsp.readFile(file, 'utf8')
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A corrupt state file must not block delivery: the worst case of starting
      // fresh is one duplicate story, the worst case of failing here is no email.
      logger?.warn?.(`dsh-auto-email: state file unreadable (${error?.message ?? error}); starting empty`)
    }
    return emptyState()
  }

  const state = emptyState()
  if (parsed && typeof parsed === 'object') {
    if (parsed.seen && typeof parsed.seen === 'object' && !Array.isArray(parsed.seen)) state.seen = { ...parsed.seen }
    for (const key of ['last_run', 'last_sent_date', 'last_sent_at', 'last_error']) {
      if (typeof parsed[key] === 'string') state[key] = parsed[key]
    }
    if (Array.isArray(parsed.runs)) state.runs = parsed.runs.filter((r) => r && typeof r === 'object')
  }
  return state
}

/**
 * Write the state atomically, pruning the sent-hash memory first.
 *
 * @param {string} file - absolute path.
 * @param {object} state - state to persist; mutated in place by the prune.
 * @param {object} [logger] - optional `{ warn }`.
 * @returns {Promise<boolean>} whether the write landed.
 */
export async function saveState(file, state, logger) {
  pruneSeen(state)
  state.runs = (state.runs ?? []).slice(0, RUN_HISTORY_LIMIT)
  const tmp = `${file}.tmp`
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await fsp.rename(tmp, file)
    return true
  } catch (error) {
    logger?.warn?.(`dsh-auto-email: could not save state: ${error?.message ?? error}`)
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

/**
 * Forget sent-title hashes older than the retention window.
 *
 * @param {object} state - mutated in place.
 * @param {Date} [now] - comparison instant.
 * @returns {number} how many entries were dropped.
 */
export function pruneSeen(state, now = new Date()) {
  const cutoff = now.getTime() - SEEN_RETENTION_DAYS * 86_400_000
  let dropped = 0
  for (const [key, value] of Object.entries(state.seen ?? {})) {
    const when = Date.parse(`${value}T00:00:00Z`)
    if (Number.isFinite(when) && when < cutoff) {
      delete state.seen[key]
      dropped += 1
    }
  }
  return dropped
}

/**
 * Was this headline already delivered?
 *
 * @param {object} state
 * @param {string} titleHash - output of `hashTitle`.
 * @returns {boolean}
 */
export function isSeen(state, titleHash) {
  return Object.hasOwn(state.seen ?? {}, titleHash)
}

/**
 * Drop already-delivered items from a candidate list.
 *
 * @param {object[]} items
 * @param {object} state
 * @param {(item: object) => string} hashOf - maps an item to its title hash.
 * @returns {{ kept: object[], dropped: number }}
 */
export function filterSeen(items, state, hashOf) {
  const kept = items.filter((item) => !isSeen(state, hashOf(item)))
  return { kept, dropped: items.length - kept.length }
}

/**
 * Mark a batch as delivered, dated, and append a run record.
 *
 * @param {object} state - mutated in place.
 * @param {string[]} titleHashes - hashes of the items that actually went out.
 * @param {string} dateStr - `YYYY-MM-DD` in the digest time zone.
 * @param {object} [extra] - `{ at, sent, error }` for the run record.
 */
export function markDelivered(state, titleHashes, dateStr, extra = {}) {
  for (const hash of titleHashes) if (hash) state.seen[hash] = dateStr
  state.last_run = extra.at ?? new Date().toISOString()
  state.last_sent_date = dateStr
  state.last_sent_at = extra.at ?? new Date().toISOString()
  state.last_error = ''
  state.runs = [{ at: state.last_run, date: dateStr, sent: extra.sent !== false, picked: extra.picked ?? 0, error: '' }, ...(state.runs ?? [])]
}

/**
 * Record a failed attempt. Deliberately does *not* touch `last_sent_date`, so a
 * failure leaves the idempotence gate open and the next trigger retries.
 *
 * @param {object} state - mutated in place.
 * @param {string} message
 * @param {object} [extra] - `{ at, date }`.
 */
export function markFailure(state, message, extra = {}) {
  state.last_run = extra.at ?? new Date().toISOString()
  state.last_error = String(message ?? '')
  state.runs = [{ at: state.last_run, date: extra.date ?? '', sent: false, picked: 0, error: state.last_error }, ...(state.runs ?? [])]
}

/**
 * Migrate a `seen.json` written by the reference Python implementation.
 *
 * @param {object|string} source - parsed JSON or its text.
 * @returns {{ seen: object, last_sent_date: string, last_sent_at: string, migrated: number }|null}
 *   `null` when the input is not a Python-shaped state file.
 */
export function migrateLegacyState(source) {
  let parsed = source
  if (typeof source === 'string') {
    try { parsed = JSON.parse(source.replace(/^\uFEFF/, '')) } catch { return null }
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.sent !== 'object' || parsed.sent === null) return null
  const seen = {}
  for (const [key, value] of Object.entries(parsed.sent)) seen[key] = String(value).slice(0, 10)
  return {
    seen,
    last_sent_date: typeof parsed.last_sent_date === 'string' ? parsed.last_sent_date : '',
    last_sent_at: typeof parsed.last_sent_at === 'string' ? parsed.last_sent_at : '',
    migrated: Object.keys(seen).length,
  }
}

/**
 * Merge a migrated legacy state into a live state object, in place.
 *
 * The merge is a union, and it is deliberately conservative in both directions:
 *
 *   - a title hash already known to the target keeps whichever date is *newer*,
 *     so re-running an import can never shorten the dedupe memory;
 *   - `last_sent_date` / `last_sent_at` are only taken from the legacy file when
 *     the target has none, or when the legacy one is newer. An import must never
 *     move the idempotence gate *backwards*, because that would let the plugin
 *     re-send a digest the user already received.
 *
 * @param {object} target - live state, mutated in place.
 * @param {object} legacy - output of {@link migrateLegacyState}.
 * @returns {{ added: number, kept: number, lastSentDate: string, tookLastSent: boolean }}
 */
export function mergeMigratedState(target, legacy) {
  if (!target || typeof target !== 'object' || !legacy) throw new TypeError('mergeMigratedState: target 与 legacy 都必须是对象')
  if (!target.seen || typeof target.seen !== 'object') target.seen = {}
  let added = 0
  let kept = 0
  for (const [hash, date] of Object.entries(legacy.seen ?? {})) {
    const current = target.seen[hash]
    if (current === undefined) { target.seen[hash] = date; added += 1; continue }
    if (String(date) > String(current)) target.seen[hash] = date
    kept += 1
  }
  let tookLastSent = false
  const legacyDate = String(legacy.last_sent_date ?? '')
  if (legacyDate && legacyDate > String(target.last_sent_date ?? '')) {
    target.last_sent_date = legacyDate
    target.last_sent_at = String(legacy.last_sent_at ?? '')
    tookLastSent = true
  }
  return { added, kept, lastSentDate: String(target.last_sent_date ?? ''), tookLastSent }
}

