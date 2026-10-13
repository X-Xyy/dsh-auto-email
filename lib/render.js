/**
 * dsh-auto-email — the mail half of the pipeline: one plain-text and one inline-CSS
 * HTML rendering of the picked items.
 *
 * Ported verbatim from `daily_ai_digest.py`'s render section (the `_CARD` template
 * included). The HTML deliberately keeps every inline style, colour and emoji: it
 * is tuned for the QQ Mail client, which drops stylesheets. Nothing here invents
 * copy — the wording was paid for by user feedback.
 *
 * `meta` keys come from the caller (Python `main()` builds them):
 * `date`, `date_cn`, `generated`, `fetched`, `clusters`, `window`,
 * `window_note`, `primary_window`, `errors`. Every key is read defensively so a
 * missing one renders as an empty value instead of throwing.
 *
 * Module top level has no side effects.
 */

import { TOPIC_LABELS, best_url, credibility, other_urls } from './digest.js';

/**
 * "MM-DD HH:MM" in Asia/Shanghai, or the literal 时间未知 when undated.
 *
 * parity: Python used `strftime("%m-%d %H:%M")` on a CST-aware datetime. `Intl`
 * produces locale punctuation ("10/13, 09:05" for en-US), so we reassemble the
 * numeric parts by hand — formatToParts is stable across locales and gives the
 * same zero-padded fields as strftime.
 *
 * @param {object} it
 * @returns {string}
 */
export function fmt_time(it) {
  const d = it.published instanceof Date && !Number.isNaN(it.published.getTime()) ? it.published : null;
  if (!d) return '时间未知';
  /** @type {Record<string, string>} */
  const p = {};
  for (const part of _shortFmt.formatToParts(d)) p[part.type] = part.value;
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const _shortFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * The credibility badge + note, shape-compatible with the Python two-tuple.
 * Kept as a local wrapper so the badge is computed in exactly one place for both
 * renderers, and so `render.js` does not depend on how the caller imports it.
 * @param {object} it
 * @returns {[string, string]}
 */
function _cred(it) {
  return credibility(it);
}

/**
 * Escape the five HTML-significant characters for text nodes and double-quoted
 * attribute values.
 *
 * DIVERGENCE FROM THE REFERENCE (deliberate): the Python `render_html` pasted
 * titles, LLM prose, source names and URLs into the template raw, so a title like
 * `<script>alert(1)</script>` — or a link containing `"` — became live markup in
 * the mail body. The reference behaviour is not reproduced here; every value that
 * can originate outside this module is escaped. Ampersand must go first, or the
 * entities produced below would themselves be re-escaped.
 *
 * @param {unknown} value
 * @returns {string}
 */
function _esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Plain-text fallback body.
 * @param {object[]} picked
 * @param {object} meta
 * @returns {string}
 */
export function render_text(picked, meta) {
  const m = meta || {};
  const L = [`AI 每日三报 · ${m.date_cn ?? ''}`, '='.repeat(46), ''];
  if (m.window_note) L.push(`※ ${m.window_note}`, '');
  picked.forEach((it, i) => {
    const [badge, note] = _cred(it);
    const aged = (it.extra || {}).aged ? '  [回溯]' : '';
    const hl = (it.extra || {}).headline || it.title;
    // 聚合器（Hacker News）条目的链接可能指向别家：如实说明主链接由谁发布
    const owner = it.cluster_best || it.source_name;
    const src = owner === it.source_name ? owner : `${owner}（线索来自 ${it.source_name}）`;
    L.push(
      `【${i + 1}】${hl}`,
      `     原文标题：${it.title}`,
      `     来源：${src} · ${fmt_time(it)} · ${TOPIC_LABELS[it.llm_topic] || '其他动态'}${aged}`,
      `     可信度：${badge} —— ${note}`,
      '',
      `  📌 事实：${(it.extra || {}).fact || ''}`,
      '',
      `  🔍 为什么重要：${(it.extra || {}).why || ''}`,
      '',
      `  🎯 对你的影响：${(it.extra || {}).impact || ''}`,
      '',
      `  ⚖️ 存疑点：${(it.extra || {}).doubt || ''}`,
      '',
      `  🔗 原文：${best_url(it)}`,
    );
    const others = other_urls(it);
    if (others.length) {
      // 用「其他来源」而不是「交叉报道」：HN 条目的链接常指向厂商自己的博客，
      // 那并不是独立报道，不能给它一个听起来像佐证的名字。
      L.push(`  🔗 其他来源：${others.join('  ')}`);
    }
    L.push('', '-'.repeat(46), '');
  });
  L.push(
    `本期采集 ${m.fetched ?? ''} 条 → 聚合为 ${m.clusters ?? ''} 个事件 → 精选 ${picked.length} 条`,
    `生成时间：${m.generated ?? ''}`,
  );
  if (m.errors && m.errors.length) L.push('信源告警：' + m.errors.join('；'));
  return L.join('\n');
}

const _CARD = `
<div style="margin:0 0 22px 0;padding:18px 20px;background:#ffffff;border:1px solid #e3e8ef;
            border-radius:10px;border-left:4px solid {accent};">
  <div style="font-size:11px;color:#8a94a6;letter-spacing:1px;margin-bottom:6px;">
    NO.{idx} &nbsp;·&nbsp; {topic} &nbsp;·&nbsp; {badge}{aged}
  </div>
  <div style="font-size:17px;font-weight:700;color:#101828;line-height:1.5;margin-bottom:5px;">
    {title}
  </div>
  <div style="font-size:12px;color:#98a2b3;line-height:1.5;margin-bottom:10px;">
    原文标题：{orig}
  </div>
  <div style="font-size:12px;color:#667085;margin-bottom:14px;padding-bottom:12px;
              border-bottom:1px dashed #e3e8ef;">
    {source} &nbsp;|&nbsp; {time} &nbsp;|&nbsp; 重要性 {imp}/10 &nbsp;|&nbsp; 新颖度 {nov}/10
  </div>

  <div style="margin-bottom:12px;">
    <span style="display:inline-block;font-size:13px;font-weight:700;color:#0b5cad;
                 margin-bottom:4px;">📌 事实</span>
    <div style="font-size:14px;line-height:1.75;color:#1d2939;">{fact}</div>
  </div>

  <div style="margin-bottom:12px;">
    <span style="display:inline-block;font-size:13px;font-weight:700;color:#0b5cad;
                 margin-bottom:4px;">🔍 为什么重要</span>
    <div style="font-size:14px;line-height:1.75;color:#1d2939;">{why}</div>
  </div>

  <div style="margin-bottom:12px;">
    <span style="display:inline-block;font-size:13px;font-weight:700;color:#0b5cad;
                 margin-bottom:4px;">🎯 对你的影响</span>
    <div style="font-size:14px;line-height:1.75;color:#1d2939;">{impact}</div>
  </div>

  <div style="margin-bottom:14px;padding:10px 12px;background:#f8fafc;border-radius:6px;">
    <span style="font-size:12px;font-weight:700;color:#475467;">⚖️ 可信度：{badge}</span>
    <div style="font-size:12px;line-height:1.7;color:#667085;margin-top:3px;">{cred_note}</div>
    <div style="font-size:12px;line-height:1.7;color:#667085;margin-top:3px;">
      存疑点：{doubt}
    </div>
  </div>

  <div style="font-size:12px;line-height:1.9;">
    {link}{extra_links}
  </div>
</div>
`;

/**
 * Render one card by substituting every `{placeholder}` in `_CARD`.
 *
 * The Python used `str.format`; a single-pass function replacer is the exact
 * equivalent here — crucially, values are inserted as *values*, so text coming
 * out of the LLM cannot be read as a format field of its own.
 *
 * @param {Record<string, string|number>} vars
 * @returns {string}
 */
function _card(vars) {
  return _CARD.replace(/\{(\w+)\}/g, (full, key) => (key in vars ? String(vars[key]) : full));
}

/**
 * HTML body: inline-CSS cards plus the source-tier and 筛选逻辑 footer.
 * @param {object[]} picked
 * @param {object} meta
 * @returns {string}
 */
export function render_html(picked, meta) {
  const m = meta || {};
  const accents = ['#0b5cad', '#7a5af8', '#0e9384'];
  const cards = [];
  picked.forEach((it, i) => {
    const [badge, note] = _cred(it);
    const owner = it.cluster_best || it.source_name;
    const src = owner === it.source_name ? owner : `${owner}（线索来自 ${it.source_name}）`;
    let extra = '';
    const others = other_urls(it);
    if (others.length) {
      extra = others
        .map(
          (u) =>
            `<br><a href="${_esc(u)}" style="color:#667085;text-decoration:none;">` +
            '&nbsp;&nbsp;↳ 其他来源</a>',
        )
        .join('');
    }
    // 没有可用链接时不发空锚点：`href=""` 在邮件客户端里会变成指向自身的死链，
    // 读者点它什么也得不到，所以退化成纯文本。
    const url = best_url(it);
    const label = `🔗 阅读原文（${_esc(src)}）`;
    const link = url
      ? `<a href="${_esc(url)}" style="color:#0b5cad;text-decoration:none;` +
        `font-weight:600;">${label}</a>`
      : `<span style="color:#0b5cad;font-weight:600;">${label}</span>`;
    cards.push(
      _card({
        accent: accents[i % accents.length],
        idx: i + 1,
        topic: _esc(TOPIC_LABELS[it.llm_topic] || '其他动态'),
        aged: (it.extra || {}).aged ? ' &nbsp;·&nbsp; <span style="color:#b54708;">回溯</span>' : '',
        badge: _esc(badge),
        title: _esc((it.extra || {}).headline || it.title),
        orig: _esc(it.title),
        source: _esc(src),
        time: _esc(fmt_time(it)),
        imp: _esc(_num(it.llm_importance)),
        nov: _esc(_num(it.llm_novelty)),
        fact: _esc((it.extra || {}).fact || ''),
        why: _esc((it.extra || {}).why || ''),
        impact: _esc((it.extra || {}).impact || ''),
        doubt: _esc((it.extra || {}).doubt || ''),
        cred_note: _esc(note),
        link,
        extra_links: extra,
      }),
    );
  });

  let warn = '';
  if (m.errors && m.errors.length) {
    warn =
      '<div style="margin:0 0 18px 0;padding:10px 14px;background:#fffaeb;' +
      'border:1px solid #fedf89;border-radius:8px;font-size:12px;color:#93670a;">' +
      '⚠️ 部分信源本次不可达：' +
      _esc(m.errors.join('；')) +
      '</div>';
  }

  let note = '';
  if (m.window_note) {
    note =
      '<div style="margin:0 0 18px 0;padding:10px 14px;background:#eff8ff;' +
      'border:1px solid #b2ddff;border-radius:8px;font-size:12px;color:#175cd3;' +
      'line-height:1.7;">ℹ️ ' +
      _esc(m.window_note) +
      '</div>';
  }

  if (!picked.length) {
    cards.push(
      '<div style="padding:28px;text-align:center;background:#f8fafc;' +
        'border-radius:10px;color:#667085;font-size:14px;line-height:1.8;">' +
        '今日未发现达到推送门槛的 AI 重大动态。<br>' +
        '<span style="font-size:12px;">（宁缺毋滥：本系统不会为凑数而推送低价值内容）</span></div>',
    );
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 每日三报 ${_esc(m.date ?? '')}</title></head>
<body style="margin:0;padding:0;background:#f2f4f7;">
<div style="max-width:680px;margin:0 auto;padding:20px 14px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',
            'Hiragino Sans GB','Microsoft YaHei',sans-serif;">

  <div style="padding:22px 24px;background:linear-gradient(135deg,#0b5cad 0%,#7a5af8 100%);
              border-radius:12px;color:#ffffff;margin-bottom:18px;">
    <div style="font-size:12px;opacity:.85;letter-spacing:2px;">DAILY AI INTELLIGENCE</div>
    <div style="font-size:23px;font-weight:800;margin:6px 0 8px 0;">AI 每日三报</div>
    <div style="font-size:13px;opacity:.92;line-height:1.6;">
      ${_esc(m.date_cn ?? '')} &nbsp;·&nbsp; 今日精选 ${picked.length} 条<br>
      <span style="font-size:12px;opacity:.8;">
        采集 ${_esc(m.fetched ?? '')} 条 → 聚合 ${_esc(m.clusters ?? '')} 个事件 → 精选 ${picked.length} 条</span>
    </div>
  </div>

  ${warn}
  ${note}
  ${cards.join('')}

  <div style="padding:16px 18px;background:#ffffff;border:1px solid #e3e8ef;border-radius:10px;
              font-size:11px;line-height:1.9;color:#8a94a6;">
    <b style="color:#475467;">信源说明</b><br>
    T1 一手官方：OpenAI / Anthropic / Google DeepMind / Hugging Face / arXiv<br>
    T2 权威媒体：量子位 / TechCrunch AI / MIT Tech Review / Simon Willison<br>
    T3 社区信号：Hacker News（永不单独成条，须有交叉验证）<br><br>
    <b style="color:#475467;">筛选逻辑</b><br>
    主窗 ${_esc(m.primary_window ?? m.window ?? '')} 小时；主窗内达标条目不足 3 条时自动回退至 48/72 小时，
    回溯条目在卡片上标注「回溯」，绝不拿低价值内容凑数；跨天永久去重；同一事件多源报道自动合并；
    三条尽量落在不同主题簇；可信度由程序按信源层级与交叉验证情况客观计算，非模型生成。<br><br>
    生成于 ${_esc(m.generated ?? '')} &nbsp;·&nbsp; 由 AI 每日三报系统自动发送
  </div>
</div></body></html>`;
}

/**
 * Python's `f"{x:g}"` for the 0-10 scores printed on a card.
 * @param {number} x
 * @returns {string}
 */
function _num(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toPrecision(6)));
}
