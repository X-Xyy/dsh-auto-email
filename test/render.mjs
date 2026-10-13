/**
 * Renderer tests for dsh-auto-email.
 *
 * These exist because `render.js` is the one module whose failures are invisible
 * to `node --check` (a stale identifier only throws when a branch runs) and
 * invisible to a dry run that happens to pick different items. Both renderers are
 * driven here with a fixture that carries every optional field, so the whole
 * branch surface is touched without touching the network.
 *
 * Run: node test/render.mjs
 */

import assert from 'node:assert/strict'

import { TOPIC_LABELS } from '../lib/digest.js'
import { fmt_time, render_html, render_text } from '../lib/render.js'

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

/** An item with every field populated, including the optional ones. */
function fixture(overrides = {}) {
  return {
    source_key: 'techcrunch',
    source_name: 'TechCrunch AI',
    tier: 2,
    title: 'Meta releases its first frontier model, Muse Wonder',
    url: 'https://techcrunch.com/2026/10/13/meta-muse-wonder/',
    summary: 'Meta released a frontier model it says matches the best closed models on reasoning.',
    published: new Date('2026-10-13T01:10:00Z'),
    extra: {
      headline: 'Meta发布首个前沿模型Muse Wonder',
      fact: 'Meta 发布了 Muse Wonder，称为其首个前沿模型。',
      why: '这是 Meta 首次把训练规模推到前沿水平，改变了开源与闭源的竞争格局。',
      impact: '如果你在选型，值得等第三方基准复现后再考虑迁移。',
      doubt: '官方未公布完整评测细节，第三方复现尚未出现。',
      topic: 'model',
      aged: true,
      event: 'meta-muse-wonder',
      budget: 350,
    },
    cluster_id: 3,
    cluster_sources: ['TechCrunch AI(T2)', '量子位(T2)'],
    cluster_urls: [
      'https://techcrunch.com/2026/10/13/meta-muse-wonder/',
      'https://www.qbitai.com/2026/10/muse-wonder.html',
    ],
    cluster_best: 'TechCrunch AI',
    prog_score: 0.63,
    llm_importance: 8,
    llm_novelty: 7,
    llm_topic: 'model',
    llm_reason: '首个前沿模型发布',
    ...overrides,
  }
}

const META = {
  date: '2026-10-13',
  date_cn: '2026年10月13日 星期一',
  generated: '2026-10-13 09:28:31',
  fetched: 246,
  clusters: 34,
  window: 72,
  primary_window: 26,
  window_note: '今日 26 小时内的新增动态不足，下列 3 条来自 72 小时回溯窗口。',
  errors: ['Google DeepMind: TypeError: fetch failed'],
}

console.log('\n== fmt_time ==')
check('a dated item renders as MM-DD HH:MM in Asia/Shanghai', () => {
  assert.equal(fmt_time(fixture()), '10-13 09:10')
})
check('a missing or invalid date degrades instead of throwing', () => {
  assert.equal(fmt_time(fixture({ published: null })), '时间未知')
  assert.equal(fmt_time(fixture({ published: new Date('nope') })), '时间未知')
})

console.log('\n== render_text ==')
const text = render_text([fixture()], META)
check('carries the header, the date and the window note', () => {
  assert.ok(text.includes('AI 每日三报 · 2026年10月13日 星期一'), 'header')
  assert.ok(text.includes('※ 今日 26 小时内的新增动态不足'), 'window note')
})
check('shows the Chinese headline and the original title beneath it', () => {
  assert.ok(text.includes('【1】Meta发布首个前沿模型Muse Wonder'))
  assert.ok(text.includes('原文标题：Meta releases its first frontier model, Muse Wonder'))
})
check('names the publishing source, not the aggregator that surfaced it', () => {
  assert.ok(text.includes('来源：TechCrunch AI · 10-13 09:10 · 模型发布  [回溯]'))
  // A HN item whose link points elsewhere must disclose the lead source.
  const hn = render_text([fixture({ source_key: 'hn', source_name: 'Hacker News', cluster_best: 'TechCrunch AI' })], META)
  assert.ok(hn.includes('来源：TechCrunch AI（线索来自 Hacker News）'))
})
check('renders all four interpretation sections with their emoji labels', () => {
  for (const label of ['📌 事实', '🔍 为什么重要', '🎯 对你的影响', '⚖️ 存疑点']) {
    assert.ok(text.includes(label), `missing ${label}`)
  }
})
check('prints the credibility badge computed by the program, not the LLM', () => {
  assert.ok(/可信度：\S+ .+ —— /.test(text), 'badge line')
})
check('lists the original and the secondary links', () => {
  assert.ok(text.includes('https://techcrunch.com/2026/10/13/meta-muse-wonder/'))
  assert.ok(text.includes('https://www.qbitai.com/2026/10/muse-wonder.html'))
})
check('an undated item does not break the line', () => {
  const undated = render_text([fixture({ published: undefined, extra: { ...fixture().extra, aged: false } })], META)
  assert.ok(undated.includes('10 时间未知') || undated.includes('时间未知'))
})
check('an item with no interpretation at all still renders', () => {
  const bare = render_text([fixture({ extra: {} })], META)
  assert.ok(bare.includes('【1】Meta releases its first frontier model, Muse Wonder'), 'falls back to the raw title')
  assert.ok(bare.includes('📌 事实：'), 'empty fact section is still labelled')
})

console.log('\n== render_html ==')
const html = render_html([fixture()], META)
check('leaves no unreplaced placeholder behind', () => {
  const leftovers = [...html.matchAll(/\{[a-z_]{2,}\}/gi)].map((m) => m[0])
  assert.deepEqual(leftovers, [], `unreplaced: ${[...new Set(leftovers)].join(', ')}`)
})
check('is a complete document with inline styles only', () => {
  assert.ok(html.trimStart().toLowerCase().startsWith('<!doctype html'))
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'QQ Mail drops external stylesheets')
  assert.ok(!/<style[\s>]/i.test(html), 'QQ Mail drops <style> blocks too')
})
check('shows the Chinese headline and the original title as a subtitle', () => {
  assert.ok(html.includes('Meta发布首个前沿模型Muse Wonder'))
  assert.ok(html.includes('原文标题：Meta releases its first frontier model, Muse Wonder'))
})
check('marks a backfilled item', () => {
  assert.ok(html.includes('回溯'), 'aged marker')
})
check('carries the window note and the source error summary', () => {
  assert.ok(html.includes('今日 26 小时内的新增动态不足'))
  assert.ok(html.includes('Google DeepMind'), 'error list must be disclosed, not hidden')
})
check('escapes HTML in every user-controlled string', () => {
  const hostile = render_html([fixture({
    title: '<script>alert(1)</script>',
    extra: { ...fixture().extra, headline: '<img src=x onerror=alert(2)>', fact: 'a & b < c > d' },
  })], META)
  assert.ok(!hostile.includes('<script>alert(1)</script>'), 'title must be escaped')
  assert.ok(!hostile.includes('onerror=alert(2)>'), 'headline must be escaped')
  assert.ok(hostile.includes('a &amp; b &lt; c &gt; d'), 'body text must be escaped')
})
check('an item with no links does not emit an empty anchor', () => {
  const lonely = render_html([fixture({ url: '', cluster_urls: [] })], META)
  assert.ok(!/href=""/.test(lonely), 'no empty href')
})
check('empty picked renders a valid page instead of throwing', () => {
  const empty = render_html([], META)
  assert.ok(empty.trimStart().toLowerCase().startsWith('<!doctype html'))
})

console.log('\n== topic labels ==')
check('every topic key a user can see has a Chinese label', () => {
  for (const key of ['model', 'research', 'product', 'opensource', 'industry', 'policy', 'other']) {
    assert.equal(typeof TOPIC_LABELS[key], 'string', `missing label for ${key}`)
  }
})

console.log(`\n${passed} checks passed${process.exitCode === 1 ? ', with failures above' : ''}`)
