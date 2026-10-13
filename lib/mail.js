/**
 * dsh-auto-email — a minimal SMTP client.
 *
 * Node ships no mail library and the project allows no dependencies, so this
 * speaks the protocol over `node:net` / `node:tls` directly. It implements only
 * what delivery needs: EHLO, optional STARTTLS, AUTH LOGIN/PLAIN, MAIL/RCPT,
 * DATA, QUIT. No pipelining, no DSN, no attachments.
 *
 * The message is assembled to match the reference implementation byte for byte
 * where it matters (`ai-daily-digest/daily_ai_digest.py:921-951`): a
 * `multipart/alternative` body with the plain-text part first, RFC 2047 encoded
 * headers, base64 parts, and a generated Message-ID.
 */

import crypto from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import tls from 'node:tls'

/** RFC 2047 "B" encoding — what Python's `email.header.Header(name, 'utf-8')`
 * produces, which is the form QQ Mail accepts. */
function encodeHeaderValue(value) {
  const text = String(value ?? '')
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(text) ? text : `=?utf-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/**
 * `"显示名" <addr>` with the display name RFC 2047 encoded when needed.
 *
 * @param {string} name - display name, may be empty.
 * @param {string} address - the addr-spec.
 * @returns {string} a header value ready to place after `From:` / `To:`.
 */
export function formatAddress(name, address) {
  const addr = String(address ?? '').trim()
  const label = String(name ?? '').trim()
  if (label === '') return addr
  const encoded = encodeHeaderValue(label)
  // A plain ASCII label containing no specials may stay unquoted.
  const plain = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(label)
  return `${plain ? label : encoded} <${addr}>`
}

/** Wrap a base64 payload at 76 columns, as the MIME spec requires. */
function wrapBase64(buffer, width = 76) {
  const base64 = Buffer.from(buffer).toString('base64')
  const lines = []
  for (let index = 0; index < base64.length; index += width) lines.push(base64.slice(index, index + width))
  return lines.join('\r\n')
}

/**
 * RFC 5322 date, e.g. `Tue, 13 Oct 2026 09:28:31 +0800`.
 *
 * @param {Date} date
 * @param {string} timeZone - IANA zone name.
 * @returns {string}
 */
export function rfc5322Date(date, timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
  const offsetRaw = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00'
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetRaw)
  const offset = match ? `${match[1]}${match[2]}${match[3]}` : '+0000'
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')} ${hour}:${get('minute')}:${get('second')} ${offset}`
}

/**
 * Assemble the full RFC 5322 message.
 *
 * @param {object} message - `{ fromName, from, to, subject, text, html, date, timeZone }`.
 * @returns {{ raw: string, messageId: string, boundary: string }}
 */
export function buildMessage(message) {
  const { fromName, from, to, subject, text, html, date = new Date(), timeZone = 'Asia/Shanghai' } = message
  const domain = String(from).split('@')[1] || os.hostname() || 'localhost'
  const messageId = `<${crypto.randomUUID()}@${domain}>`
  const boundary = `--=_dsh_auto_email_${crypto.randomBytes(12).toString('hex')}`

  const headers = [
    `From: ${formatAddress(fromName, from)}`,
    `To: ${to.map((address) => formatAddress('我', address)).join(', ')}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${rfc5322Date(date, timeZone)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]

  const part = (contentType, body) => [
    `--${boundary}`,
    `Content-Type: ${contentType}; charset="utf-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(body, 'utf8')),
  ].join('\r\n')

  const raw = [
    ...headers,
    '',
    part('text/plain', text),
    part('text/html', html),
    `--${boundary}--`,
    '',
  ].join('\r\n')

  return { raw, messageId, boundary }
}

/**
 * Line-oriented SMTP reply reader.
 *
 * A reply is one or more lines; the last line carries a space after the status
 * code (`250 OK`) while continuation lines carry a hyphen (`250-STARTTLS`).
 *
 * @param {import('node:net').Socket} socket
 * @returns {{ read: (timeoutMs: number) => Promise<{code: number, lines: string[]}>, detach: () => void }}
 */
function makeChannel(socket) {
  let buffer = ''
  let pending = null
  let collected = []
  let failed = null

  const settle = (error, reply) => {
    if (!pending) return
    const { resolve, reject, timer } = pending
    pending = null
    collected = []
    clearTimeout(timer)
    if (error) reject(error)
    else resolve(reply)
  }

  const onData = (chunk) => {
    buffer += chunk.toString('utf8')
    if (!pending) return
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      collected.push(line)
      if (/^\d{3}[ ]/.test(line) || /^\d{3}$/.test(line)) {
        settle(null, { code: Number(line.slice(0, 3)), lines: [...collected] })
        return
      }
    }
  }
  const onError = (error) => { failed = error; settle(error) }
  const onClose = () => { settle(new Error('SMTP 连接被对端关闭')) }

  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)

  return {
    read(timeoutMs) {
      if (failed) return Promise.reject(failed)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(new Error(`SMTP 响应超时（${timeoutMs}ms）`))
        }, timeoutMs)
        pending = { resolve, reject, timer }
        onData(Buffer.alloc(0))
      })
    },
    detach() {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    },
  }
}

/** Wait for a connect-ish event, or fail on error/timeout. */
function once(socket, event, errorEvent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`SMTP 连接超时（${timeoutMs}ms）`)) }, timeoutMs)
    const onDone = () => { cleanup(); resolve() }
    const onFail = (error) => { cleanup(); reject(error) }
    function cleanup() {
      clearTimeout(timer)
      socket.off(event, onDone)
      socket.off(errorEvent, onFail)
    }
    socket.once(event, onDone)
    socket.once(errorEvent, onFail)
  })
}

/** Human-readable form of a server reply, for error messages and logs. */
function replyText(reply) {
  return reply.lines.map((line) => line.replace(/^\d{3}[- ]?/, '')).filter(Boolean).join(' ').slice(0, 300)
}

/** Throw unless the reply code is one of `expected`. */
function expect(reply, expected, what) {
  if (expected.includes(reply.code)) return
  throw new Error(`${what} 失败：服务器返回 ${reply.code} ${replyText(reply)}`)
}

/**
 * Run one SMTP session to completion.
 *
 * @param {object} cfg - the `email` config section.
 * @param {string} raw - the assembled message.
 * @param {object} [logger] - optional `{ info, warn }`.
 * @returns {Promise<{ accepted: string[] }>}
 */
async function deliverOnce(cfg, raw, logger) {
  const host = cfg.smtp_host
  const port = Number(cfg.smtp_port) || (cfg.use_ssl ? 465 : 587)
  const timeoutMs = Number(cfg.timeoutMs) || 45_000
  const heloDomain = String(cfg.username).split('@')[1] || os.hostname() || 'localhost'

  let socket = cfg.use_ssl
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
    : net.connect({ host, port })
  socket.setTimeout(timeoutMs)

  await once(socket, cfg.use_ssl ? 'secureConnect' : 'connect', 'error', timeoutMs)
  let channel = makeChannel(socket)

  const command = async (line) => {
    socket.write(`${line}\r\n`)
    return channel.read(timeoutMs)
  }

  try {
    expect(await channel.read(timeoutMs), [220], 'SMTP 问候')

    let ehlo = await command(`EHLO ${heloDomain}`)
    if (ehlo.code !== 250) ehlo = await command(`HELO ${heloDomain}`)
    expect(ehlo, [250], 'EHLO')

    if (!cfg.use_ssl) {
      expect(await command('STARTTLS'), [220], 'STARTTLS')
      channel.detach()
      const plain = socket
      socket = tls.connect({ socket: plain, servername: host, rejectUnauthorized: true })
      await once(socket, 'secureConnect', 'error', timeoutMs)
      socket.setTimeout(timeoutMs)
      channel = makeChannel(socket)
      ehlo = await command(`EHLO ${heloDomain}`)
      expect(ehlo, [250], 'STARTTLS 后的 EHLO')
    }

    // Prefer AUTH LOGIN (what QQ Mail advertises); fall back to PLAIN.
    const capabilities = ehlo.lines.join(' ').toUpperCase()
    if (capabilities.includes('AUTH') && capabilities.includes('LOGIN')) {
      expect(await command('AUTH LOGIN'), [334], 'AUTH LOGIN')
      expect(await command(Buffer.from(cfg.username, 'utf8').toString('base64')), [334], 'AUTH 用户名')
      expect(await command(Buffer.from(cfg.auth_code, 'utf8').toString('base64')), [235], 'AUTH 授权码')
    } else {
      const token = Buffer.from(`\0${cfg.username}\0${cfg.auth_code}`, 'utf8').toString('base64')
      expect(await command(`AUTH PLAIN ${token}`), [235], 'AUTH PLAIN')
    }

    expect(await command(`MAIL FROM:<${cfg.username}>`), [250], 'MAIL FROM')

    const accepted = []
    for (const address of cfg.to) {
      const reply = await command(`RCPT TO:<${address}>`)
      if (reply.code === 250 || reply.code === 251) accepted.push(address)
      else logger?.warn?.(`dsh-auto-email: 收件人被拒 ${address}：${reply.code} ${replyText(reply)}`)
    }
    if (accepted.length === 0) throw new Error('所有收件人都被服务器拒绝')

    expect(await command('DATA'), [354], 'DATA')

    // Dot-stuffing: a body line that is exactly "." would end the message early.
    const stuffed = raw.replace(/\r\n\./g, '\r\n..').replace(/\n\./g, '\n..')
    socket.write(`${stuffed}\r\n.\r\n`)
    const stored = await channel.read(timeoutMs)
    expect(stored, [250], '邮件正文')

    await command('QUIT').catch(() => {})
    channel.detach()
    socket.end()
    return { accepted }
  } finally {
    channel?.detach?.()
    socket.destroy()
  }
}

/**
 * Send one digest email, retrying transient failures three times with a widening
 * pause — the same cadence as the reference implementation's `5 * (attempt + 1)`.
 *
 * @param {object} cfg - the `email` config section.
 * @param {object} message - `{ subject, text, html, date?, timeZone? }`.
 * @param {object} [logger] - optional `{ info, warn }`.
 * @returns {Promise<{ messageId: string, accepted: string[], subject: string }>}
 */
export async function sendMail(cfg, message, logger) {
  const { raw, messageId } = buildMessage({
    fromName: cfg.from_name,
    from: cfg.username,
    to: cfg.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    date: message.date ?? new Date(),
    timeZone: message.timeZone ?? cfg.timezone ?? 'Asia/Shanghai',
  })

  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await deliverOnce(cfg, raw, logger)
      logger?.info?.(`邮件已投递 -> ${result.accepted.join(', ')}`)
      return { messageId, accepted: result.accepted, subject: message.subject }
    } catch (error) {
      lastError = error
      logger?.warn?.(`投递失败(第 ${attempt + 1} 次): ${String(error?.message ?? error).slice(0, 200)}`)
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 5_000 * (attempt + 1)))
    }
  }
  throw lastError ?? new Error('邮件投递失败')
}

/**
 * Connect, authenticate, and disconnect without sending — the panel's "test
 * connection" action. Surfaces an auth failure instead of a send failure, which
 * is the difference the user needs to see.
 *
 * @param {object} cfg - the `email` config section.
 * @returns {Promise<{ ok: true, greeting: string }>}
 */
export async function verifySmtp(cfg) {
  const host = cfg.smtp_host
  const port = Number(cfg.smtp_port) || (cfg.use_ssl ? 465 : 587)
  const timeoutMs = Number(cfg.timeoutMs) || 45_000
  const heloDomain = String(cfg.username).split('@')[1] || os.hostname() || 'localhost'

  let socket = cfg.use_ssl
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
    : net.connect({ host, port })
  socket.setTimeout(timeoutMs)
  await once(socket, cfg.use_ssl ? 'secureConnect' : 'connect', 'error', timeoutMs)
  const channel = makeChannel(socket)

  try {
    const greeting = await channel.read(timeoutMs)
    expect(greeting, [220], 'SMTP 问候')
    socket.write(`EHLO ${heloDomain}\r\n`)
    let ehlo = await channel.read(timeoutMs)
    expect(ehlo, [250], 'EHLO')
    if (!cfg.use_ssl) {
      socket.write('STARTTLS\r\n')
      expect(await channel.read(timeoutMs), [220], 'STARTTLS')
      channel.detach()
      socket = tls.connect({ socket, servername: host, rejectUnauthorized: true })
      await once(socket, 'secureConnect', 'error', timeoutMs)
    }
    const capabilities = ehlo.lines.join(' ').toUpperCase()
    if (capabilities.includes('AUTH') && capabilities.includes('LOGIN')) {
      socket.write('AUTH LOGIN\r\n')
      expect(await channel.read(timeoutMs), [334], 'AUTH LOGIN')
      socket.write(`${Buffer.from(cfg.username, 'utf8').toString('base64')}\r\n`)
      expect(await channel.read(timeoutMs), [334], 'AUTH 用户名')
      socket.write(`${Buffer.from(cfg.auth_code, 'utf8').toString('base64')}\r\n`)
      expect(await channel.read(timeoutMs), [235], 'AUTH 授权码')
    } else {
      const token = Buffer.from(`\0${cfg.username}\0${cfg.auth_code}`, 'utf8').toString('base64')
      socket.write(`AUTH PLAIN ${token}\r\n`)
      expect(await channel.read(timeoutMs), [235], 'AUTH PLAIN')
    }
    socket.write('QUIT\r\n')
    channel.detach()
    return { ok: true, greeting: replyText(greeting) }
  } finally {
    socket.destroy()
  }
}
