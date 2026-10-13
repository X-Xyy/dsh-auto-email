/**
 * Offline smoke test for dsh-auto-email.
 *
 * Exercises the wiring that is easy to get subtly wrong and cannot be caught by
 * `node --check`: module import graph, config layering, the time-zone arithmetic
 * behind the schedule, MIME assembly, and the service's due logic. No network.
 *
 * Run: node tmp/smoke-plugin.mjs
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DEFAULTS, mergeDeep, resolveConfig, validate } from '../lib/config.js'
import { buildMessage, formatAddress, rfc5322Date } from '../lib/mail.js'
import { createService, dayKey, stamp, zonedTargetInstant } from '../lib/service.js'
import { emptyState, mergeMigratedState, migrateLegacyState, pruneSeen } from '../lib/state.js'

let passed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  [ OK ] ${label}`)
  } catch (error) {
    console.log(`  [FAIL] ${label}\n         ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
const checkAsync = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  [ OK ] ${label}`)
  } catch (error) {
    console.log(`  [FAIL] ${label}\n         ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

const TZ = 'Asia/Shanghai'

console.log('\n== time zone arithmetic ==')
check('zonedTargetInstant maps 08:00 CST to 00:00Z', () => {
  const target = zonedTargetInstant(new Date('2026-10-12T23:30:00Z'), TZ, '08:00')
  assert.equal(target.toISOString(), '2026-10-13T00:00:00.000Z')
})
check('zonedTargetInstant keeps the calendar day of the reference', () => {
  const target = zonedTargetInstant(new Date('2026-10-13T09:15:00Z'), TZ, '08:00')
  assert.equal(target.toISOString(), '2026-10-13T00:00:00.000Z')
})
check('dayKey is zone-local, not UTC', () => {
  // 2026-10-13T00:30Z is already 08:30 on the 13th in Shanghai.
  assert.equal(dayKey(new Date('2026-10-13T00:30:00Z'), TZ), '2026-10-13')
  assert.equal(dayKey(new Date('2026-10-12T17:30:00Z'), TZ), '2026-10-13')
})
check('stamp is `YYYY-MM-DD HH:MM:SS`', () => {
  assert.equal(stamp(new Date('2026-10-13T00:30:05Z'), TZ), '2026-10-13 08:30:05')
})

console.log('\n== MIME assembly ==')
check('rfc5322Date carries the zone offset', () => {
  const value = rfc5322Date(new Date('2026-10-13T01:28:31Z'), TZ)
  assert.match(value, /^Tue, 13 Oct 2026 09:28:31 \+0800$/)
})
check('a non-ASCII display name becomes an RFC 2047 encoded word', () => {
  const value = formatAddress('AI 每日三报', 'a@qq.com')
  assert.match(value, /^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <a@qq\.com>$/)
})
check('an ASCII display name stays plain and unquoted', () => {
  assert.equal(formatAddress('Digest', 'a@qq.com'), 'Digest <a@qq.com>')
  assert.equal(formatAddress('', 'a@qq.com'), 'a@qq.com')
})
check('multipart/alternative is well formed with the text part first', () => {
  const { raw, boundary } = buildMessage({
    fromName: 'AI 每日三报', from: 'a@qq.com', to: ['b@qq.com'], subject: '【AI日报】测试',
    text: '纯文本', html: '<p>HTML</p>', date: new Date('2026-10-13T01:28:31Z'), timeZone: TZ,
  })
  assert.match(raw, /^From: =\?utf-8\?B\?[^?]+\?= <a@qq\.com>\r\n/)
  assert.match(raw, /Subject: =\?utf-8\?B\?[^?]+\?=\r\n/)
  assert.match(raw, /Message-ID: <[^>]+@qq\.com>\r\n/)
  assert.match(raw, new RegExp(`Content-Type: multipart/alternative; boundary="${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
  const plainAt = raw.indexOf('Content-Type: text/plain; charset="utf-8"')
  const htmlAt = raw.indexOf('Content-Type: text/html; charset="utf-8"')
  assert.ok(plainAt > 0 && htmlAt > plainAt, 'plain part must precede the html part')
  assert.ok(raw.endsWith(`--${boundary}--\r\n`), 'must end with the closing boundary')
  // Both parts are base64 of the UTF-8 source.
  assert.ok(raw.includes(Buffer.from('纯文本', 'utf8').toString('base64')))
})
check('header injection through a subject is neutralised', () => {
  const { raw } = buildMessage({
    fromName: 'x', from: 'a@qq.com', to: ['b@qq.com'], subject: 'ok\r\nBcc: victim@example.com',
    text: 't', html: 'h', date: new Date('2026-10-13T01:28:31Z'), timeZone: TZ,
  })
  // The subject is RFC 2047 encoded, so the injected CRLF cannot start a header.
  assert.ok(!/^Bcc:/m.test(raw), 'injected header must not appear as its own line')
})

console.log('\n== config layering ==')
const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dae-smoke-'))
await checkAsync('defaults survive with no options', async () => {
  const cfg = await resolveConfig({ dataDir: tmpRoot }, { secret: {} })
  assert.equal(cfg.llm.model, DEFAULTS.llm.model)
  assert.equal(cfg.schedule.time, '08:00')
  assert.equal(cfg.email.smtp_host, 'smtp.qq.com')
  assert.equal(cfg.paths.stateFile, path.join(tmpRoot, 'state.json'))
})
await checkAsync('layer order is DEFAULTS < options < overrides < secrets', async () => {
  const cfg = await resolveConfig(
    { dataDir: tmpRoot, llm: { model: 'from-options' }, email: { to: ['options@x.com'] } },
    { secret: { deepseek_api_key: 'sk-secret', smtp_auth_code: 'code', smtp_username: 'u@qq.com', recipients: ['secret@x.com'] } },
  )
  assert.equal(cfg.llm.model, 'from-options')
  assert.equal(cfg.llm.api_key, 'sk-secret', 'a secret key fills in but does not override an explicit option')
  assert.equal(cfg.email.auth_code, 'code')
  assert.equal(cfg.email.username, 'u@qq.com')
  assert.deepEqual(cfg.email.to, ['options@x.com'], 'an explicit recipient list beats the secret file')
})
await checkAsync('a malformed schedule time falls back instead of arming a dead timer', async () => {
  const warnings = []
  const cfg = await resolveConfig({ dataDir: tmpRoot, schedule: { time: '25:99' } }, { secret: {}, logger: { warn: (m) => warnings.push(m) } })
  assert.equal(cfg.schedule.time, '08:00')
  assert.equal(warnings.length, 1)
})
await checkAsync('email.to accepts a comma string', async () => {
  const cfg = await resolveConfig({ dataDir: tmpRoot, email: { to: ['a@x.com', 'b@x.com'] } }, { secret: {} })
  assert.deepEqual(cfg.email.to, ['a@x.com', 'b@x.com'])
})
await checkAsync('validate lists every missing credential at once', async () => {
  const cfg = await resolveConfig({ dataDir: tmpRoot }, { secret: {} })
  const problems = validate(cfg)
  assert.equal(problems.length, 4, `expected 4 problems, got ${problems.length}: ${problems.join('；')}`)
})
await checkAsync('mergeDeep does not mutate its inputs', async () => {
  const base = { a: { b: 1 } }
  const merged = mergeDeep(base, { a: { c: 2 } })
  assert.deepEqual(base, { a: { b: 1 } })
  assert.deepEqual(merged, { a: { b: 1, c: 2 } })
})

console.log('\n== state ==')
check('a legacy Python state shape migrates without losing history', () => {
  const migrated = migrateLegacyState({ sent: { abc: '2026-10-12' }, last_sent_date: '2026-10-12', last_sent_at: '2026-10-12 09:28:31' })
  assert.equal(migrated.migrated, 1)
  assert.equal(migrated.seen.abc, '2026-10-12')
  assert.equal(migrated.last_sent_date, '2026-10-12')
})
check('a non-Python shape is refused rather than silently emptied', () => {
  assert.equal(migrateLegacyState({ seen: {} }), null)
  assert.equal(migrateLegacyState('not json'), null)
})
check('emptyState carries every field the idempotence gate reads', () => {
  const state = emptyState()
  for (const key of ['seen', 'last_run', 'last_sent_date', 'last_sent_at', 'last_error', 'runs']) {
    assert.ok(Object.hasOwn(state, key), `missing ${key}`)
  }
})
check('pruneSeen forgets only entries past the retention window', () => {
  const now = new Date('2026-10-13T00:00:00Z')
  const state = { seen: { fresh: '2026-10-12', stale: '2026-01-01' } }
  assert.equal(pruneSeen(state, now), 1)
  assert.deepEqual(Object.keys(state.seen), ['fresh'])
})

// The migration is the one operation that can cause a *re-send* if it is wrong,
// so it gets tested from both directions rather than just the happy path.
check('mergeMigratedState unions the dedupe memory', () => {
  const target = { seen: { a: '2026-10-10' }, last_sent_date: '2026-10-10' }
  const merged = mergeMigratedState(target, { seen: { a: '2026-10-12', b: '2026-10-13' }, last_sent_date: '2026-10-13', last_sent_at: '2026-10-13 09:28:31' })
  assert.equal(merged.added, 1)
  assert.equal(merged.kept, 1)
  assert.deepEqual(target.seen, { a: '2026-10-12', b: '2026-10-13' })
  assert.equal(merged.lastSentDate, '2026-10-13')
  assert.equal(merged.tookLastSent, true)
})
check('mergeMigratedState never moves the idempotence gate backwards', () => {
  const target = { seen: {}, last_sent_date: '2026-10-13' }
  const merged = mergeMigratedState(target, { seen: {}, last_sent_date: '2026-10-11', last_sent_at: '2026-10-11 08:00:00' })
  assert.equal(target.last_sent_date, '2026-10-13', '旧文件的更早日期绝不能覆盖当前闸门')
  assert.equal(merged.tookLastSent, false)
})
check('mergeMigratedState never shortens a known date, so re-importing is a no-op', () => {
  const target = { seen: { a: '2026-10-12' }, last_sent_date: '' }
  const merged = mergeMigratedState(target, { seen: { a: '2026-10-01' }, last_sent_date: '' })
  assert.equal(target.seen.a, '2026-10-12')
  assert.equal(merged.added, 0)
  assert.equal(merged.kept, 1)
})
check('a second identical import adds nothing', () => {
  const legacy = migrateLegacyState({ sent: { x: '2026-10-13' }, last_sent_date: '2026-10-13', last_sent_at: '2026-10-13 09:28:31' })
  const target = { seen: {}, last_sent_date: '' }
  assert.equal(mergeMigratedState(target, legacy).added, 1)
  assert.equal(mergeMigratedState(target, legacy).added, 0)
  assert.equal(Object.keys(target.seen).length, 1)
})

console.log('\n== service due logic ==')
const service = await createService({ options: { dataDir: tmpRoot }, logger: {}, secret: {} })
const at = (iso) => new Date(iso)
check('before the target time it is not due', () => {
  assert.equal(service.isDue(at('2026-10-12T23:00:00Z')).reason, 'before-time')
})
check('after the target time it is due', () => {
  assert.equal(service.isDue(at('2026-10-13T00:30:00Z')).reason, 'due')
})
check('once today is sent it stays quiet', () => {
  service.state.last_sent_date = '2026-10-13'
  assert.equal(service.isDue(at('2026-10-13T02:00:00Z')).reason, 'already-sent')
  service.state.last_sent_date = ''
})
check('past the catch-up window it gives up rather than sending stale news', () => {
  // 12h catch-up: 08:00 CST + 12h = 20:00 CST = 12:00Z.
  assert.equal(service.isDue(at('2026-10-13T13:00:00Z')).reason, 'too-late')
})
check('disabling the schedule stops everything', () => {
  service.cfg.schedule.enabled = false
  assert.equal(service.isDue(at('2026-10-13T00:30:00Z')).reason, 'disabled')
  service.cfg.schedule.enabled = true
})
check('nextRunAt rolls to tomorrow once today has passed', () => {
  const next = service.nextRunAt(at('2026-10-13T13:00:00Z'))
  assert.equal(dayKey(next, TZ), '2026-10-14')
  assert.equal(stamp(next, TZ).slice(11), '08:00:00')
})
await checkAsync('while a run is in flight the timer reports busy, not an error', async () => {
  // Live evidence this guards against: with tick_seconds=30 and a ~2.5 minute
  // run, `last_sent_date` stays empty until the run finishes, so every tick
  // still saw `due` and called runOnce(), which threw on the inFlight check and
  // logged "定时运行失败：已有一次运行正在进行中" four times per run.
  assert.equal(service.isDue(at('2026-10-13T00:30:00Z')).reason, 'due', 'precondition: due')
  const first = service.runIfDue(at('2026-10-13T00:30:00Z')) // validates and fails: credentials absent, no network
  const second = await service.runIfDue(at('2026-10-13T00:30:00Z'))
  assert.equal(second.ran, false)
  assert.equal(second.reason, 'busy', `expected busy, got ${second.reason}: ${second.error ?? ''}`)
  const settled = await first
  assert.notEqual(settled.reason, 'busy', 'the first call is the one that actually runs')
})
check('getStatus reports the documented shape', () => {
  const status = service.getStatus(at('2026-10-13T00:30:00Z'))
  for (const key of ['enabled', 'due', 'due_reason', 'next_run_at', 'schedule', 'problems', 'state', 'running', 'last_outcome', 'paths']) {
    assert.ok(Object.hasOwn(status, key), `missing ${key}`)
  }
  assert.equal(status.email.auth_code_set, false)
  assert.ok(!JSON.stringify(status).includes('auth_code":'), 'the raw secret must never be serialised')
})

console.log('\n== panel config write ==')
await checkAsync('saveConfig persists and re-resolves, ignoring unknown keys', async () => {
  const result = await service.saveConfig({ 'schedule.time': '07:30', 'email.to': ['z@x.com'], 'llm.api_key': 'leak' })
  assert.deepEqual(result.saved.sort(), ['email.to', 'schedule.time'])
  assert.deepEqual(result.ignored, ['llm.api_key'], 'secrets must not be writable through the config route')
  assert.equal(service.cfg.schedule.time, '07:30')
  assert.deepEqual(service.cfg.email.to, ['z@x.com'])
  const written = JSON.parse(await fsp.readFile(path.join(tmpRoot, 'config.json'), 'utf8'))
  assert.equal(written.llm?.api_key, undefined)
  assert.equal(written.schedule.time, '07:30')
  assert.deepEqual(written.email.to, ['z@x.com'])
})

await fsp.rm(tmpRoot, { recursive: true, force: true })

console.log(`\n${passed} checks passed${process.exitCode === 1 ? ', with failures above' : ''}`)
