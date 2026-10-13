/**
 * dsh-auto-email — the run pipeline: fetch, filter, cluster, rank, pick, interpret, render.
 *
 * This is a straight port of `main()` in the reference implementation
 * (`ai-daily-digest/daily_ai_digest.py:1020-1180`). Step numbering, log wording,
 * thresholds and the order of operations all match, so the two can be diffed
 * side by side when a result looks wrong.
 *
 * It deliberately stops before transport: no SMTP, no state mutation on disk
 * beyond the preview/archive files. The caller decides whether to send.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  best_url,
  dedup_and_cluster,
  llm_interpret,
  llm_rank,
  merge_by_event,
  norm_title,
  programmatic_score,
  select_progressive,
  TOPIC_LABELS,
  h,
} from './digest.js'
import { render_html, render_text } from './render.js'
import { fetch_all, fetch_meta_description } from './sources.js'

/** Chinese weekday names, indexed by `Date#getUTCDay`. Not used in `date_cn`
 * (parity: the Python build prints `%Y年%m月%d日` with no weekday) — kept for
 * the panel, which shows a friendlier date. */
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六']

/** `YYYY-MM-DD` in the digest time zone. */
function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** `YYYY-MM-DD HH:MM:SS` in the digest time zone. */
function stamp(date, timeZone) {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
  return `${dayKey(date, timeZone)} ${clock}`
}

/** `YYYY年MM月DD日` — the exact shape the reference build prints. */
function dateCn(date, timeZone) {
  const [year, month, day] = dayKey(date, timeZone).split('-')
  return `${year}年${month}月${day}日`
}

/**
 * `YYYY年MM月DD日 星期X` — what the copy for the *lead* story carries, where a
 * weekday reads better than a bare date.
 */
export function friendlyDate(date, timeZone) {
  const key = dayKey(date, timeZone)
  const [year, month, day] = key.split('-').map(Number)
  return `${year}年${month}月${day}日 星期${WEEKDAY_CN[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}`
}

/** `await sleep(ms)`; used to be polite to article hosts during backfill. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build the progressive window ladder. The primary window always comes first;
 * fallbacks are de-duplicated and sorted so "widen" is monotonic.
 *
 * @param {object} cfg - resolved config.
 * @param {number|null} overrideHours - `--hours`, which pins a single window and
 *   disables fallback entirely (that is what the reference CLI does).
 * @returns {number[]} ascending windows in hours, at least one entry.
 */
export function windowLadder(cfg, overrideHours = null) {
  if (overrideHours != null && Number.isFinite(Number(overrideHours))) return [Number(overrideHours)]
  const primary = Number(cfg.digest.window_hours) || 26
  const fallbacks = (cfg.digest.fallback_window_hours ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  return [...new Set([primary, ...fallbacks])].sort((a, b) => a - b)
}

/**
 * Turn the picked rows into a small, serialisable summary — what the Agent tool
 * returns and what the panel lists. Article bodies and prompts stay out of it.
 *
 * @param {object[]} picked - items after `llm_interpret`.
 * @returns {object[]} one entry per story.
 */
export function summarizePicked(picked) {
  return picked.map((item) => ({
    headline: item.extra?.headline || item.title,
    original_title: item.title,
    url: best_url(item),
    other_sources: (item.cluster_urls ?? []).filter((url) => url !== best_url(item)).slice(0, 2),
    source: item.cluster_best || item.source_name,
    tier: item.tier,
    topic: item.llm_topic,
    topic_label: TOPIC_LABELS?.[item.llm_topic] ?? item.llm_topic,
    importance: item.llm_importance,
    novelty: item.llm_novelty,
    aged: Boolean(item.extra?.aged),
    reason: item.llm_reason ?? '',
    fact: item.extra?.fact ?? '',
    why: item.extra?.why ?? '',
    impact: item.extra?.impact ?? '',
    doubt: item.extra?.doubt ?? '',
    budget: item.extra?.budget ?? 0,
    actual_len: (item.extra?.fact ?? '').length + (item.extra?.why ?? '').length + (item.extra?.impact ?? '').length,
  }))
}

/**
 * Run the whole digest build.
 *
 * @param {object} cfg - resolved config (`resolveConfig`).
 * @param {object} [options]
 * @param {(msg: string) => void} [options.log] - progress sink; defaults to silence.
 * @param {boolean} [options.dryRun] - write preview files instead of archives.
 * @param {number|null} [options.hours] - pin a single window, disabling fallback.
 * @param {number|null} [options.topN] - override `digest.top_n`.
 * @param {boolean} [options.noLlm] - skip ranking and interpretation (diagnostics only).
 * @param {boolean} [options.ignoreSeen] - do not drop already-delivered titles.
 * @param {Date} [options.now] - injectable clock for tests.
 * @returns {Promise<object>} `{ subject, html, text, meta, picked, stories, errors, stats }`.
 */
export async function runDigest(cfg, options = {}) {
  const log = options.log ?? (() => {})
  const dryRun = Boolean(options.dryRun)
  const noLlm = Boolean(options.noLlm)
  const ignoreSeen = Boolean(options.ignoreSeen)
  const now = options.now instanceof Date ? options.now : new Date()
  const timeZone = cfg.email?.timezone || 'Asia/Shanghai'

  const topN = Number(options.topN ?? cfg.digest.top_n) || 3
  const minImp = Number(cfg.digest.min_importance ?? 6)
  const windows = windowLadder(cfg, options.hours)
  /** Widest window: what collection, the time filter, and scoring all use. */
  const span = windows[windows.length - 1]

  const startedAt = Date.now()
  const errors = []
  let items = []
  let fresh = []
  let clusters = []
  let pool = []
  let picked = []
  let windowUsed = windows[0]

  // ---- 1. 采集
  log('【1/6】采集信源…')
  const fetched = await fetch_all({
    window_hours: span,
    arxiv_max: cfg.digest.arxiv_max_items,
    hn_max: cfg.digest.hn_max_items,
    log,
  })
  items = fetched.items ?? []
  errors.push(...(fetched.errors ?? []))
  log(`采集完成：${items.length} 条原始条目，${errors.length} 个信源异常`)

  // ---- 2. 时间窗 + 状态库过滤
  const cutoff = now.getTime() - span * 3_600_000
  fresh = items.filter((it) => it.published instanceof Date && it.published.getTime() >= cutoff)
  const undated = items.filter((it) => !(it.published instanceof Date)).length
  log(`【2/6】时间窗过滤：${fresh.length} 条在 ${span.toFixed(0)} 小时内（丢弃 ${items.length - fresh.length - undated} 条过期，${undated} 条无日期）`)

  const state = options.state ?? { seen: {} }
  const seen = state.seen ?? {}
  const before = fresh.length
  if (!ignoreSeen) fresh = fresh.filter((it) => !Object.hasOwn(seen, h(norm_title(it.title))))
  log(`       跨天去重：剔除 ${before - fresh.length} 条已推送过的内容`)

  if (fresh.length === 0) {
    log('没有新的候选条目。')
    picked = []
    clusters = []
    windowUsed = windows[0]
  } else {
    // ---- 3. 聚类
    log('【3/6】事件聚类…')
    clusters = dedup_and_cluster(fresh)
    const multi = clusters.filter((group) => new Set(group.map((m) => m.source_key)).size >= 2).length
    log(`       ${fresh.length} 条 -> ${clusters.length} 个事件（其中 ${multi} 个获多源交叉报道）`)

    // ---- 4. 打分
    log('【4/6】打分排序…')
    for (const it of fresh) it.prog_score = programmatic_score(it, span)

    const rankedPool = [...fresh].sort((a, b) => b.prog_score - a.prog_score)
    const cap = Number(cfg.digest.max_candidates_for_ranking) || 90
    pool = rankedPool.slice(0, cap)
    log(`       程序预筛保留 ${pool.length} 条进入 LLM 排序`)

    // 摘要补全：部分信源（Anthropic 列表页、HN）只给标题，LLM 无法解读。
    // 限量抓取文章页 og:description，避免给目标站点造成压力。
    const briefMax = Number(cfg.digest.brief_max_chars) || 40
    const thin = pool.filter((it) => (it.summary ?? '').length < Math.max(60, briefMax)).slice(0, Number(cfg.digest.backfill_thin) || 14)
    if (thin.length > 0) {
      let got = 0
      for (const it of thin) {
        const description = await fetch_meta_description(best_url(it))
        if (description) {
          it.summary = description
          got += 1
        }
        await sleep(600)
      }
      log(`       摘要补全：${got}/${thin.length} 条候选成功获取文章页描述`)
    }

    if (!noLlm) {
      try {
        await llm_rank(cfg.llm, pool, `${dayKey(now, timeZone).slice(0, 4)}年${dayKey(now, timeZone).slice(5, 7)}月${dayKey(now, timeZone).slice(8, 10)}日`, log)
      } catch (error) {
        log(`LLM 排序失败，退回纯程序打分：${String(error?.message ?? error).slice(0, 200)}`)
        errors.push(`LLM排序失败: ${String(error?.message ?? error).slice(0, 60)}`)
      }
    } else {
      for (const it of pool) {
        it.llm_importance = 5
        it.llm_novelty = 5
        it.llm_topic = 'other'
      }
    }

    // ---- 5. 选 Top3 + 解读
    const mergedGroups = merge_by_event(pool, log)
    if (mergedGroups > 0) log(`       语义归并补足：${mergedGroups} 组事件获得程序未识别的交叉信源`)

    ;[picked, windowUsed] = select_progressive(pool, topN, windows, { min_imp: minImp })

    if (windowUsed > windows[0]) {
      log(`       主窗 ${windows[0].toFixed(0)}h 内达标条目不足 ${topN} 条，已回退到 ${windowUsed.toFixed(0)}h 窗口`)
    }
    log(`【5/6】精选 ${picked.length} 条：`)
    picked.forEach((it, index) => {
      let aged = ''
      if (it.published instanceof Date) {
        const ageHours = (now.getTime() - it.published.getTime()) / 3_600_000
        if (ageHours > windows[0]) {
          aged = `  ← 回溯 ${ageHours.toFixed(0)}h`
          it.extra.aged = true
        }
      }
      log(`       ${index + 1}. [${TOPIC_LABELS?.[it.llm_topic] ?? '?'}] ${it.title.slice(0, 56)}  (imp=${it.llm_importance} nov=${it.llm_novelty}, ${it.source_name})${aged}`)
    })

    if (picked.length > 0 && !noLlm) {
      try {
        await llm_interpret(cfg.llm, picked, log, { max_retry: 2 })
        for (const it of picked) {
          const budget = it.extra.budget ?? 0
          const got = (it.extra.fact ?? '').length + (it.extra.why ?? '').length + (it.extra.impact ?? '').length
          log(`       解读 ${it.title.slice(0, 28)}：目标 ${budget} 字 / 实际 ${got} 字`)
        }
      } catch (error) {
        log(`LLM 解读失败，降级为仅事实：${String(error?.message ?? error).slice(0, 200)}`)
        errors.push(`LLM解读失败: ${String(error?.message ?? error).slice(0, 60)}`)
        for (const it of picked) {
          Object.assign(it.extra, { fact: '（解读生成失败，请直接阅读原文）', why: '', impact: '', doubt: '' })
        }
      }
    } else if (picked.length > 0) {
      for (const it of picked) {
        Object.assign(it.extra, {
          fact: (it.summary ?? '').slice(0, 200),
          why: '',
          impact: '',
          doubt: '（--no-llm 模式）',
        })
      }
    }
  }

  // ---- 6. 渲染
  const head = picked.length > 0 ? (picked[0].extra.headline || picked[0].title).slice(0, 34) : '今日无重大动态'
  const agedCount = picked.filter((it) => it.extra.aged).length
  let windowNote = ''
  if (agedCount > 0 && windowUsed > windows[0]) {
    windowNote = `今日 ${windows[0].toFixed(0)} 小时内的新增动态不足，下列 ${agedCount} 条来自 `
      + `${windowUsed.toFixed(0)} 小时回溯窗口（邮件内已标注「回溯」）。`
      + '系统原则是宁缺毋滥：宁可回溯，也不拿低价值内容凑数。'
  }

  const meta = {
    date: dayKey(now, timeZone),
    date_cn: dateCn(now, timeZone),
    generated: stamp(now, timeZone),
    fetched: items.length,
    clusters: clusters.length,
    window: windowUsed.toFixed(0),
    window_note: windowNote,
    primary_window: windows[0].toFixed(0),
    errors,
  }

  const html = render_html(picked, meta)
  const text = render_text(picked, meta)
  const subject = `【AI日报】${meta.date} · ${head}`

  // 试跑不覆盖当天真实归档（否则「先真发一次、再试跑」会把已投递的记录冲掉）
  if (dryRun) {
    await fsp.mkdir(cfg.paths.previewDir, { recursive: true })
    await fsp.writeFile(path.join(cfg.paths.previewDir, `${meta.date}.md`), text, 'utf8')
    await fsp.writeFile(path.join(cfg.paths.previewDir, `${meta.date}.html`), html, 'utf8')
    log(`--dry-run：未发送、未归档、未写状态。预览文件：${path.join(cfg.paths.previewDir, meta.date)}.html / .md`)
  } else {
    await fsp.mkdir(cfg.paths.archiveDir, { recursive: true })
    await fsp.writeFile(path.join(cfg.paths.archiveDir, `${meta.date}.html`), html, 'utf8')
    await fsp.writeFile(path.join(cfg.paths.archiveDir, `${meta.date}.md`), text, 'utf8')
    log(`【6/6】已归档到 ${path.join(cfg.paths.archiveDir, meta.date)}`)
  }

  return {
    subject, html, text, meta, picked, errors,
    stories: summarizePicked(picked),
    stats: {
      fetched: items.length,
      in_window: fresh.length,
      dropped_seen: before - fresh.length,
      clusters: clusters.length,
      sent_to_llm: pool.length,
      picked: picked.length,
      window_used: windowUsed,
      primary_window: windows[0],
      elapsed_ms: Date.now() - startedAt,
    },
  }
}
