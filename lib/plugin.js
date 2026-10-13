/**
 * dsh-auto-email — host half.
 *
 * Turns the digest pipeline into a switchable DSH plugin:
 *
 *   - three shared tools, so the agent can report status, build a preview, or
 *     send on demand;
 *   - a loopback-only HTTP surface for the sidebar panel;
 *   - a due-check timer that fires the digest once a day at the configured time,
 *     catching up if DSH was not running at that moment.
 *
 * `lib/service.js` holds the actual behaviour; this file is wiring only.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createService } from './service.js'

/** Plugin name reported to the Loader. */
export const name = 'dsh-auto-email'

/** Required host services; anything else is reached through `ctx.get`. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/**
 * Plugin options. These live in `cordis.patch.yml` and win over defaults; the
 * panel writes its own overrides to `<dataDir>/config.json`, and secrets go to
 * their own file so this one can stay in version control.
 */
export const Config = z.object({
  /** Where archives, logs and state live; empty means `<userData>/dsh-auto-email`. */
  dataDir: z.string().default(''),
  llm: z.object({
    base_url: z.string().default('https://api.deepseek.com'),
    api_key: z.string().default(''),
    model: z.string().default('deepseek-chat'),
  }).default({}),
  digest: z.object({
    top_n: z.number().default(3),
    window_hours: z.number().default(26),
    min_importance: z.number().default(6),
    send_when_empty: z.boolean().default(true),
  }).default({}),
  email: z.object({
    smtp_host: z.string().default('smtp.qq.com'),
    smtp_port: z.number().default(465),
    use_ssl: z.boolean().default(true),
    username: z.string().default(''),
    from_name: z.string().default('AI 每日三报'),
    to: z.array(z.string()).default([]),
    timezone: z.string().default('Asia/Shanghai'),
  }).default({}),
  schedule: z.object({
    enabled: z.boolean().default(true),
    time: z.string().default('08:00'),
    catch_up_hours: z.number().default(12),
    tick_seconds: z.number().default(30),
  }).default({}),
})

export const PROMPT_SECTION = 'tool:dsh-auto-email'

const PROMPT = `The dsh-auto-email plugin delivers a daily AI news digest by email. Use dsh_auto_email_status to report whether it is armed, the next run time, and any missing configuration; dsh_auto_email_preview to build today's three stories without sending; dsh_auto_email_send to send one now; dsh_auto_email_configure to change non-secret settings such as the send time or recipient list.

Credentials (the DeepSeek API key and the SMTP authorization code) are never set through a tool and never belong in conversation. If status reports a missing credential, tell the user to open the plugin's sidebar panel, or to save {"deepseek_api_key":"...","smtp_auth_code":"..."} to the secret file whose path status prints.`

//#region ------------------------------------------------------------------ HTTP helpers

/** Duplicated from the other local plugins on purpose: a plugin may not import
 * another plugin's private modules, and the loopback fence is security-relevant
 * enough to be worth restating here. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  if (address === '::1' || address === '::ffff:127.0.0.1') return true
  return address.startsWith('127.') || address.startsWith('::ffff:127.')
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '::1') return true
  return /^127(\.\d{1,3}){3}$/.test(hostname)
}

function isLoopbackRequest(request) {
  // The socket address is authoritative; forwarded headers are client-controlled.
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return isLoopbackHostname(hostname)
}

function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

async function readJsonBody(request, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

//#endregion

//#region ------------------------------------------------------------------ tools

/** `dsh_auto_email_status` — read-only snapshot of arming, config and history. */
function statusTool(service) {
  return defineTool({
    name: 'dsh_auto_email_status',
    description: 'Report the dsh-auto-email plugin state: whether the daily send is armed, when it will next run, whether it is due now, which configuration is still missing, and what happened on recent runs. Reads only; never sends mail.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          due: { type: 'boolean', required: true },
          due_reason: { type: 'string', required: true },
          next_run_at: { type: 'string', required: true },
          schedule_time: { type: 'string', required: true },
          schedule_timezone: { type: 'string', required: true },
          problems: { type: 'array', required: true, items: { type: 'string' } },
          last_sent_date: { type: 'string', required: true },
          last_sent_at: { type: 'string', required: true },
          last_error: { type: 'string', required: true },
          seen_count: { type: 'integer', required: true },
          secret_file: { type: 'string', required: true },
          data_dir: { type: 'string', required: true },
          recipients: { type: 'array', required: true, items: { type: 'string' } },
          recent_runs: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'AI 日报状态' }),
    async execute() {
      const status = service.getStatus()
      return {
        enabled: status.enabled,
        due: status.due,
        due_reason: status.due_reason,
        next_run_at: status.next_run_at,
        schedule_time: status.schedule.time,
        schedule_timezone: status.schedule.timezone,
        problems: status.problems,
        last_sent_date: status.state.last_sent_date,
        last_sent_at: status.state.last_sent_at,
        last_error: status.state.last_error,
        seen_count: status.state.seen_count,
        secret_file: status.paths.secretFile,
        data_dir: status.paths.dataDir,
        recipients: status.email.to,
        recent_runs: status.state.recent_runs.map((entry) => `${entry.at} ${entry.sent ? '已发送' : '失败'} ${entry.picked} 条 ${entry.error ?? ''}`.trim()),
      }
    },
  })
}

/** `dsh_auto_email_preview` — build today's digest, write preview files, send nothing. */
function previewTool(service) {
  return defineTool({
    name: 'dsh_auto_email_preview',
    description: 'Build today\'s AI digest and return the three selected stories with their interpretations, WITHOUT sending any email. Writes preview HTML/Markdown next to the plugin data. Use this to show the user what tomorrow\'s mail will look like, or to test after a configuration change.',
    parameters: {
      hours: { type: 'integer', description: 'Pin a single look-back window in hours instead of the default 26h-with-fallback ladder. Useful for a quick smoke test (e.g. 6).' },
      top_n: { type: 'integer', description: 'How many stories to select. Defaults to the configured value (3).' },
      ignore_seen: { type: 'boolean', description: 'Ignore the cross-day dedupe memory so already-sent stories may be selected again. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          date: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          window_hours: { type: 'number', required: true },
          window_note: { type: 'string', required: true },
          preview_markdown: { type: 'string', required: true },
          preview_html: { type: 'string', required: true },
          stories: { type: 'array', required: true, items: { type: 'string' } },
          errors: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 900_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', kind: 'execute', title: 'AI 日报预览', rawInput: args }),
    async execute(args, exec) {
      const lines = []
      const result = await service.runOnce({
        dryRun: true,
        hours: args?.hours ?? null,
        topN: args?.top_n ?? null,
        ignoreSeen: Boolean(args?.ignore_seen),
        noLlm: false,
        log: (message) => lines.push(message),
      })
      return {
        ok: true,
        date: result.meta.date,
        subject: result.subject,
        window_hours: Number(result.meta.window),
        window_note: result.meta.window_note ?? '',
        preview_markdown: path.join(service.cfg.paths.previewDir, `${result.meta.date}.md`),
        preview_html: path.join(service.cfg.paths.previewDir, `${result.meta.date}.html`),
        stories: result.stories.map((story) => `${story.headline}｜${story.source}｜imp=${story.importance} nov=${story.novelty}｜${story.url}`),
        errors: result.errors,
      }
    },
  })
}

/** `dsh_auto_email_send` — run the pipeline and deliver the mail. */
function sendTool(service) {
  return defineTool({
    name: 'dsh_auto_email_send',
    description: 'Build the AI digest and send it by email now. This is the same work the daily schedule does, so it will mark the stories as delivered and suppress the scheduled send for the rest of the day. Takes several minutes because it fetches around a dozen sources and calls the LLM.',
    parameters: {
      force: { type: 'boolean', description: 'Send even if today\'s digest was already delivered. Without this the call is refused, to avoid double-sending.' },
      hours: { type: 'integer', description: 'Pin a single look-back window in hours instead of the default ladder.' },
      top_n: { type: 'integer', description: 'How many stories to select. Defaults to the configured value (3).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          date: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          sent: { type: 'boolean', required: true },
          skipped: { type: 'string', required: true },
          recipients: { type: 'array', required: true, items: { type: 'string' } },
          window_hours: { type: 'number', required: true },
          window_note: { type: 'string', required: true },
          archive_markdown: { type: 'string', required: true },
          stories: { type: 'array', required: true, items: { type: 'string' } },
          errors: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 900_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', kind: 'execute', title: '发送 AI 日报', rawInput: args }),
    async execute(args) {
      const status = service.getStatus()
      const today = status.target_today.slice(0, 10)
      const already = status.state.last_sent_date === today
      if (already && !args?.force) {
        throw { code: 'ALREADY_SENT', message: `${today} 的日报已经投递过（${status.state.last_sent_at}）。如果确实要重发，请带 force=true。` }
      }

      const lines = []
      const result = await service.runOnce({
        dryRun: false,
        hours: args?.hours ?? null,
        topN: args?.top_n ?? null,
        ignoreSeen: Boolean(args?.force),
        log: (message) => lines.push(message),
      })

      return {
        ok: true,
        date: result.meta.date,
        subject: result.subject,
        sent: Boolean(result.sent),
        skipped: result.skipped ?? '',
        recipients: result.mail?.accepted ?? [],
        window_hours: Number(result.meta.window),
        window_note: result.meta.window_note ?? '',
        archive_markdown: path.join(service.cfg.paths.archiveDir, `${result.meta.date}.md`),
        stories: result.stories.map((story) => `${story.headline}｜${story.source}｜imp=${story.importance} nov=${story.novelty}｜${story.url}`),
        errors: result.errors,
      }
    },
  })
}

/** `dsh_auto_email_configure` — change non-secret settings. */
function configureTool(service) {
  return defineTool({
    name: 'dsh_auto_email_configure',
    description: 'Change non-secret dsh-auto-email settings, such as the daily send time, recipient list, story count, or look-back window. Credentials cannot be set here — direct the user to the sidebar panel or the secret file instead.',
    parameters: {
      set: {
        type: 'object',
        // dsh-tools validates parameter schemas at defineTool() time and rejects an
        // object-typed parameter that does not state this explicitly ("unsupported
        // JSON schema: parameters.set.additionalProperties must be explicitly true
        // or false"). The whole point of this parameter is arbitrary dotted keys,
        // so the answer here is `true`.
        additionalProperties: true,
        description: 'Dotted keys to change, e.g. {"schedule.time":"07:30","email.to":["a@b.com"],"digest.top_n":5}. Allowed keys: dataDir, llm.base_url, llm.model, llm.timeoutMs, digest.top_n, digest.window_hours, digest.min_importance, digest.send_when_empty, digest.max_candidates_for_ranking, digest.arxiv_max_items, digest.hn_max_items, email.smtp_host, email.smtp_port, email.use_ssl, email.username, email.from_name, email.to, email.timezone, schedule.enabled, schedule.time, schedule.catch_up_hours, schedule.timezone.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          saved: { type: 'array', required: true, items: { type: 'string' } },
          ignored: { type: 'array', required: true, items: { type: 'string' } },
          next_run_at: { type: 'string', required: true },
          schedule_time: { type: 'string', required: true },
          recipients: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', kind: 'execute', title: '配置 AI 日报', rawInput: args }),
    async execute(args) {
      const result = await service.saveConfig(args?.set ?? {})
      const status = service.getStatus()
      return {
        ok: true,
        saved: result.saved,
        ignored: result.ignored,
        next_run_at: status.next_run_at,
        schedule_time: status.schedule.time,
        recipients: status.email.to,
      }
    },
  })
}

//#endregion

//#region ------------------------------------------------------------------ routes

/** Route table, mirrored by the browser half. */
export const ROUTES = {
  status: '/api/dsh-auto-email/status',
  run: '/api/dsh-auto-email/run',
  config: '/api/dsh-auto-email/config',
  secret: '/api/dsh-auto-email/secret',
  testSmtp: '/api/dsh-auto-email/test-smtp',
  archive: '/api/dsh-auto-email/archive',
  archiveList: '/api/dsh-auto-email/archive-list',
  reset: '/api/dsh-auto-email/reset',
}

/** Wrap a handler with the loopback fence and uniform error reporting. */
function route(service, methods, handler) {
  return async (request, response) => {
    if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'loopback only' })
    if (!methods.includes(request.method)) return writeJson(response, 405, { ok: false, error: `${methods.join('/')} only` })
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const body = request.method === 'POST' ? await readJsonBody(request) : {}
      return await handler({ url, body, service, request, response })
    } catch (error) {
      const status = Number(error?.status) || 500
      return writeJson(response, status, { ok: false, error: String(error?.message ?? error) })
    }
  }
}

/**
 * Mount the panel routes.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} service - the runtime service.
 * @returns {Array<() => void>} disposers.
 */
export function mountRoutes(ctx, service) {
  return [
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.status,
      handler: route(service, ['GET'], async ({ service: svc, response }) => writeJson(
        response,
        200,
        { ok: true, status: svc.getStatus() },
      )),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.run,
      handler: route(service, ['POST'], async ({ body, service: svc, response }) => {
        // A run takes minutes, so this returns as soon as it has started and the
        // panel follows progress by polling /status. `last_outcome` carries the result.
        const started = svc.beginRun({
          dryRun: body?.dry_run !== false,
          hours: body?.hours ?? null,
          topN: body?.top_n ?? null,
          ignoreSeen: Boolean(body?.ignore_seen),
          log: () => {},
        })
        return writeJson(response, started.started ? 202 : 409, {
          ok: started.started,
          started: started.started,
          reason: started.reason ?? '',
        })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.config,
      handler: route(service, ['POST'], async ({ body, service: svc, response }) => {
        const saved = await svc.saveConfig(body?.set ?? {})
        return writeJson(response, 200, { ok: true, ...saved, status: svc.getStatus() })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.secret,
      handler: route(service, ['POST'], async ({ body, service: svc, response }) => {
        const saved = await svc.saveSecret(body ?? {})
        return writeJson(response, 200, { ok: true, ...saved, status: svc.getStatus() })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.testSmtp,
      handler: route(service, ['POST'], async ({ service: svc, response }) => {
        const result = await svc.verifySmtp()
        return writeJson(response, 200, { ok: true, ...result })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.archiveList,
      handler: route(service, ['GET'], async ({ service: svc, response }) => {
        let entries = []
        try {
          entries = (await fsp.readdir(svc.cfg.paths.archiveDir))
            .filter((file) => file.endsWith('.md'))
            .map((file) => file.slice(0, -3))
            .sort()
            .reverse()
        } catch { /* no archive yet */ }
        return writeJson(response, 200, { ok: true, dates: entries })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.archive,
      handler: route(service, ['GET'], async ({ url, service: svc, response }) => {
        const date = String(url.searchParams.get('date') ?? '')
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return writeJson(response, 400, { ok: false, error: 'date must be YYYY-MM-DD' })
        }
        // The name is validated above, so it cannot escape the archive directory.
        const base = path.join(svc.cfg.paths.archiveDir, date)
        const [html, text] = await Promise.all([
          fsp.readFile(`${base}.html`, 'utf8').catch(() => ''),
          fsp.readFile(`${base}.md`, 'utf8').catch(() => ''),
        ])
        if (html === '' && text === '') return writeJson(response, 404, { ok: false, error: 'no archive for that date' })
        return writeJson(response, 200, { ok: true, date, html, text })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.reset,
      handler: route(service, ['POST'], async ({ body, service: svc, response }) => {
        // Deliberately narrow: this clears memory so a day can be re-sent, and
        // nothing else. Archives are never deleted from here.
        if (body?.last_sent) {
          svc.state.last_sent_date = ''
          svc.state.last_sent_at = ''
        }
        if (body?.seen) svc.state.seen = {}
        const { saveState } = await import('./state.js')
        await saveState(svc.cfg.paths.stateFile, svc.state, ctx.logger)
        return writeJson(response, 200, { ok: true, status: svc.getStatus() })
      }),
    }),
  ]
}

//#endregion

/**
 * Plugin entry point.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} [config] - validated plugin options.
 */
export async function apply(ctx, config) {
  const service = await createService({ options: config ?? {}, logger: ctx.logger })

  ctx.tools.register(statusTool(service))
  ctx.tools.register(previewTool(service))
  ctx.tools.register(sendTool(service))
  ctx.tools.register(configureTool(service))

  ctx.systemPrompt.section({ name: PROMPT_SECTION, order: 116, text: PROMPT })

  ctx.effect(() => {
    service.start()
    return () => service.stop()
  }, 'dsh-auto-email: scheduler')

  ctx.effect(() => {
    const disposers = mountRoutes(ctx, service)
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-auto-email: routes')

  const status = service.getStatus()
  ctx.logger.info(
    'auto-email: ready; at=%s tz=%s to=%s problems=%d data=%s',
    status.schedule.time,
    status.schedule.timezone,
    status.email.to.join(',') || '(未配置)',
    status.problems.length,
    status.paths.dataDir,
  )
  if (status.problems.length > 0) ctx.logger.warn('auto-email: %s', status.problems.join('；'))
}
