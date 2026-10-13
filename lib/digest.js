/**
 * dsh-auto-email — the digest half of the pipeline: normalise → cluster → score →
 * rank (LLM) → pick → interpret (LLM).
 *
 * This is a line-by-line port of `daily_ai_digest.py` (ai-daily-digest). That Python
 * is the behaviour baseline, not a source of inspiration: every threshold, regex,
 * prompt and log string is kept verbatim so the two files can still be diffed.
 * Where the Python does something that looks improvable, the original is preserved
 * and the reason is recorded in a `// parity:` comment.
 *
 * Not ported on purpose (other modules own them): `setup_logging`, `load_config`,
 * `send_email`, `load_state`, `save_state`, `main`.
 *
 * Two things the Python never had to think about:
 *  - time: window arithmetic runs on UTC instants and only *formatting* touches
 *    `Asia/Shanghai`; the host machine's local timezone is never consulted.
 *  - `sim`: `difflib.SequenceMatcher.ratio` is reimplemented here from scratch.
 *
 * Module top level has no side effects.
 */

import { createHash } from 'node:crypto';

/**
 * China Standard Time, as a fixed UTC offset in minutes.
 * Python used `timezone(timedelta(hours=8))`; the same offset is applied when
 * formatting, via the IANA zone below (which is a constant UTC+8, no DST).
 * @type {number}
 */
export const CST = 480;

/** The zone every display timestamp is rendered in. */
const CST_ZONE = 'Asia/Shanghai';

/** Topic cluster key → Chinese label used in mail, logs and cards. */
export const TOPIC_LABELS = {
  model: '模型发布',
  research: '研究突破',
  product: '产品工具',
  opensource: '开源生态',
  industry: '产业资本',
  policy: '政策安全',
  other: '其他动态',
};

/**
 * Strong "something actually happened" vocabulary, copied verbatim from the Python.
 *
 * Deliberately NOT global: `python re` has no stateful `lastIndex`, but a /g RegExp
 * does, so a shared /g regex would make `SIGNAL_WORDS.test(...)` flip between true
 * and false on identical input. Counting every hit is done with the private /g copy
 * below instead, keeping `.match()`/`.test()` on the export stateless.
 */
export const SIGNAL_WORDS =
  /(发布|推出|开源|上线|开放|突破|首个|首次|刷新|超越|登顶|融资|收购|合并|监管|法案|禁令|标准|白皮书|基准|评测|SOTA|release|launch|open[\s\-]?source|unveil|announc|breakthrough|first|funding|raise|acquisition|regulat|benchmark|outperform|beat|record|state[\s\-]?of[\s\-]?the[\s\-]?art)/i;

/** Global twin of SIGNAL_WORDS, used only where every hit must be counted. */
const _SIGNAL_WORDS_G =
  /(发布|推出|开源|上线|开放|突破|首个|首次|刷新|超越|登顶|融资|收购|合并|监管|法案|禁令|标准|白皮书|基准|评测|SOTA|release|launch|open[\s\-]?source|unveil|announc|breakthrough|first|funding|raise|acquisition|regulat|benchmark|outperform|beat|record|state[\s\-]?of[\s\-]?the[\s\-]?art)/gi;

// ================================================================ 工具 / helpers

const _PUNCT = /[^\p{L}\p{N}_\u4e00-\u9fff]+/gu;

const _STOP = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with', 'is',
  'are', 'how', 'why', 'what', 'new', 'via', 'from', 'by', 'at', 'as', 'its',
  'your', 'you', 'we', 'it', 'this', 'that', 'ai', 'using', 'use',
]);

// 中文高频二元组，出现于大量无关标题中，作为聚类实体时噪声极大 -> 剔除
const _CJK_STOP = new Set([
  '模型', '发布', '推出', '上线', '开源', '我们', '一个', '可以', '如何', '什么',
  '已经', '这个', '他们', '因为', '所以', '但是', '而且', '以及', '或者', '如果',
  '进行', '通过', '使用', '需要', '可能', '开始', '目前', '现在', '未来', '技术',
  '研究', '公司', '团队', '产品', '能力', '性能', '数据', '训练', '测试', '支持',
  '实现', '问题', '方式', '方法', '结果', '效果', '用户', '系统', '平台', '领域',
]);

// parity: 与 Python 的 _LINK_PREFIX_RE 逐字对齐，连那个「本意是分隔符、实际写成了
// 字面量 s」的 `[\s\-–—]?` 也照抄 —— 把 `\s` 修成空格会改变归一化结果，而下游的
// 相似度阈值全是按现有行为调出来的。此处只做一处最小改动：Python/JS 的 `\w`
// 恰好一致（字母、数字、下划线），因此 `_PUNCT` 用 `\p{L}\p{N}_` 表达同一语义，
// 但显式加 `u` 标志（Python 的 str 正则本身就是码点语义）。
const _LINK_PREFIX_RE =
  /^\s*(?:quoting|quotes?|quoted|linking\s+to|links?|notes?|re)\s*[:\-–—]?\s+?/i;

/** `01`-pad a number. @param {number} n @returns {string} */
function _p2(n) {
  return String(n).padStart(2, '0');
}

/** Split an instant into its Asia/Shanghai calendar fields (never local time). */
const _partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: CST_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

/**
 * The Asia/Shanghai wall-clock fields of a UTC instant.
 * @param {Date} d
 * @returns {{ y: string, mo: string, d: string, h: string, mi: string, s: string }}
 */
function _cstParts(d) {
  const out = {};
  for (const p of _partsFmt.formatToParts(d)) out[p.type] = p.value;
  // Node's ICU can render midnight as `24` with hour12:false; normalise it.
  if (out.hour === '24') out.hour = '00';
  return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

/**
 * "YYYY-MM-DD HH:MM:SS" in Asia/Shanghai — stands in for `datetime.strftime`.
 * @param {Date} d
 * @returns {string}
 */
function _cstStamp(d) {
  const p = _cstParts(d);
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}:${p.s}`;
}

/**
 * "MM-DD HH:MM" in Asia/Shanghai.
 * @param {Date} d
 * @returns {string}
 */
function _cstShort(d) {
  const p = _cstParts(d);
  return `${p.mo}-${p.d} ${p.h}:${p.mi}`;
}

/** A date usable for display, or `null` (never an Invalid Date). */
function _asDate(v) {
  return v instanceof Date && !Number.isNaN(v.getTime()) ? v : null;
}

/**
 * Python's `int(x)` truncation towards zero, for the finite numbers we pass it.
 * @param {number} x
 * @returns {number}
 */
function _trunc(x) {
  return x < 0 ? Math.ceil(x) : Math.floor(x);
}

/**
 * Python's `round()`: banker's rounding, half to even.
 * @param {number} x
 * @returns {number}
 */
function _round(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Python's `format(x, 'g')` for the 0-10 scores we print: integers stay bare,
 * fractions keep up to six significant digits.
 * @param {number} x
 * @returns {string}
 */
function _g(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toPrecision(6)));
}

/**
 * Tolerant logger: any subset of `info` / `warning` / `error` may be missing.
 * A bare function is also accepted and treated as the whole sink (the pipeline
 * passes `options.log ?? (() => {})`, a plain `(msg) => void`), and a missing or
 * unusable `log` degrades to silence rather than throwing.
 */
function _mklog(log) {
  if (typeof log === 'function') return { info: log, warning: log, error: log };
  const src = log || {};
  const bind = (k) => (typeof src[k] === 'function' ? src[k].bind(src) : () => {});
  return { info: bind('info'), warning: bind('warning'), error: bind('error') };
}

// ============================================================ 归一化 / 相似度

/**
 * Normalise a title for comparison: strip the link-blog template prefix, then
 * strip every non-word character. Lowercased.
 *
 * parity: 链接博客的模板化标题（如 Simon Willison 的 "Quoting X"）必须先剥掉引导词，
 * 否则 "Quoting The New York Times" 与 "Quoting Matthew Green" 会因共享 "quoting"
 * 一词、相似度 0.64 而被误判为同一事件（一次真实错聚）。
 *
 * @param {string} t - raw title.
 * @returns {string} comparable form.
 */
export function norm_title(t) {
  const s = String(t ?? '').toLowerCase();
  return s.replace(_LINK_PREFIX_RE, '').replace(_PUNCT, '');
}

/**
 * Extract the "entity fingerprint" used for cross-source clustering: Latin
 * tokens minus stop words, plus CJK bigrams minus the high-frequency noise list.
 *
 * @param {string} t - raw title.
 * @returns {Set<string>} entity set.
 */
export function entities(t) {
  const stripped = String(t ?? '').replace(_LINK_PREFIX_RE, '');
  const ents = new Set();
  for (const x of stripped.match(/[A-Za-z][A-Za-z0-9.\-+]{1,}/g) || []) {
    const low = x.toLowerCase();
    if (!_STOP.has(low)) ents.add(low);
  }
  for (const run of stripped.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!_CJK_STOP.has(bg)) ents.add(bg);
    }
  }
  return ents;
}

/**
 * Build the `b2j` index Python's SequenceMatcher builds: element → sorted list of
 * its positions in `b`.
 * @param {string[]} b
 * @returns {Map<string, number[]>}
 */
function _index(b) {
  const b2j = new Map();
  for (let j = 0; j < b.length; j++) {
    const arr = b2j.get(b[j]);
    if (arr) arr.push(j);
    else b2j.set(b[j], [j]);
  }
  return b2j;
}

/**
 * `SequenceMatcher.__chain_b()`'s element index for `b`, plus the junk set it
 * derives. The autojunk heuristic is what actually fires here: for `b` longer
 * than 100 elements, any element occurring in more than 1% of `b` is removed from
 * `b2j` and treated as junk — Python enables autojunk by default, and `sim()`
 * calls `SequenceMatcher(None, a, b)` with no explicit flag, so it is on.
 *
 * Title-length strings never reach that threshold, so the heuristic is inert in
 * production; it is implemented so `sim` is not silently a different function on
 * long input.
 *
 * @param {string[]} b
 * @returns {{ b2j: Map<string, number[]>, junk: Set<string> }}
 */
function _chainB(b) {
  const b2j = _index(b);
  const n = b.length;
  const junk = new Set();
  if (n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    for (const [el, idxs] of b2j) {
      if (idxs.length > ntest) {
        junk.add(el);
        b2j.delete(el);
      }
    }
  }
  return { b2j, junk };
}

/**
 * `find_longest_match(alo, ahi, blo, bhi)` over `b2j`, with `isbjunk` forcing the
 * tie-break towards the earliest non-junk block. Returns `[i, j, size]`, or
 * `[ahi, bhi, 0]` when nothing matches.
 * @param {string[]} a
 * @param {string[]} b
 * @param {Map<string, number[]>} b2j
 * @param {Set<string>} junk
 * @param {number} alo
 * @param {number} ahi
 * @param {number} blo
 * @param {number} bhi
 * @returns {number[]}
 */
function _findLongestMatch(a, b, b2j, junk, alo, ahi, blo, bhi) {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map();

  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    for (const j of b2j.get(a[i]) || []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) || 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }

  // `isbjunk` in the Python source is `b2j.__contains__` — i.e. "still has at
  // least one non-junk position", not "is in the autojunk set". Titles never hit
  // the autojunk threshold, so the two coincide in practice; the first expression
  // is the faithful one.
  const isBjunk = (el) => !b2j.has(el) || junk.has(el);
  while (besti > alo && bestj > blo && !isBjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
    besti--;
    bestj--;
    bestsize++;
  }
  while (
    besti + bestsize < ahi &&
    bestj + bestsize < bhi &&
    !isBjunk(b[bestj + bestsize]) &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize++;
  }
  while (besti > alo && bestj > blo && isBjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
    besti--;
    bestj--;
    bestsize++;
  }
  while (
    besti + bestsize < ahi &&
    bestj + bestsize < bhi &&
    isBjunk(b[bestj + bestsize]) &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize++;
  }
  return [besti, bestj, bestsize];
}

/**
 * `SequenceMatcher.get_matching_blocks()`: the longest match of the whole range,
 * then the same recursion on the left and right remainders.
 * @param {string[]} a
 * @param {string[]} b
 * @param {Map<string, number[]>} b2j
 * @param {Set<string>} junk
 * @param {number} alo
 * @param {number} ahi
 * @param {number} blo
 * @param {number} bhi
 * @returns {number[][]} `[ai, bj, size]` triples, terminated by the zero-size block.
 */
function _matchingBlocks(a, b, b2j, junk, alo, ahi, blo, bhi) {
  const match = _findLongestMatch(a, b, b2j, junk, alo, ahi, blo, bhi);
  const i = match[0];
  const j = match[1];
  const k = match[2];
  if (k) {
    // Python's generator skips trailing junk: it walks the block from its end and
    // reports the non-junk size. `start` is that size, not an offset.
    let nonjunk = null;
    let start = 0;
    while (k > start) {
      if (junk.has(b[j + k - start - 1])) nonjunk = null;
      else if (nonjunk === null) nonjunk = k - start;
      start++;
    }
    if (nonjunk !== null) start = nonjunk;
    return [
      ..._matchingBlocks(a, b, b2j, junk, alo, i, blo, j),
      [i, j, start],
      ..._matchingBlocks(a, b, b2j, junk, i + start, ahi, j + start, bhi),
    ];
  }
  return [];
}

/**
 * `difflib.SequenceMatcher(None, a, b).ratio()` — reimplemented, because Node has
 * no stdlib equivalent. The ratio is `2 * M / T`, where `M` is the number of
 * characters covered by the non-overlapping longest matching blocks (NOT an
 * edit-distance similarity) and `T = len(a) + len(b)`.
 *
 * Autojunk (`isjunk` empty in the Python call, `autojunk=True` by default) is
 * modelled too: it only ever fires for sequences longer than 100 elements, and
 * `b2j` entries dropped for being popular are also treated as junk starts.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} ratio in [0, 1]; `0` when either side is empty.
 */
export function sim(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (!sa || !sb) return 0.0;
  const A = Array.from(sa);
  const B = Array.from(sb);
  const { b2j, junk } = _chainB(B);

  let matches = 0;
  for (const [, , size] of _matchingBlocks(A, B, b2j, junk, 0, A.length, 0, B.length)) {
    matches += size;
  }
  return (2.0 * matches) / (A.length + B.length);
}

/**
 * `hashlib.sha1(s.encode('utf-8')).hexdigest()[:20]` — the cross-day dedup key
 * stored in `seen.json`.
 * @param {string} s
 * @returns {string} first 20 hex characters of the SHA-1 digest.
 */
export function h(s) {
  return createHash('sha1').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 20);
}

// ============================================================ 去重 + 事件聚类

/**
 * Cluster reprints / multi-source reports of one story. Mutates every item in
 * place (writing `cluster_id`, `cluster_sources`, `cluster_urls`, `cluster_best`)
 * and returns the groups, which the caller counts and inspects for corroboration.
 *
 * parity: 用 IDF 思路抑制误合 —— 只有「罕见实体」（在整个候选池里出现
 * ≤ max(2, N/20) 次）才算证据。"ai"、"the"、"ai agent" 这类高频词在无关标题之间
 * 也会重叠，不能作为同一事件的证据。
 *
 * parity: **单实体规则已删除**（原版 `len(shared) >= 1 and r >= 0.5` 那条会错合）。
 * 宁可漏合，不可错合 —— 错合会虚增可信度；语义层面的同一件事交给排序 LLM 的
 * event 归并，程序层只认强证据。
 *
 * @param {object[]} items - `createItem()` rows; mutated in place.
 * @returns {object[][]} one array of items per cluster, in first-seen order.
 */
export function dedup_and_cluster(items) {
  const prepared = items.map((it) => ({ it, nt: norm_title(it.title), ent: entities(it.title) }));

  // 文档频率：实体在多少条标题里出现过
  const df = new Map();
  for (const p of prepared) {
    for (const e of p.ent) df.set(e, (df.get(e) || 0) + 1);
  }
  const rare_cap = Math.max(2, Math.floor(prepared.length / 20));

  /** @type {{nt: string, ent: Set<string>, items: object[]}[]} */
  const clusters = [];
  for (const { it, nt, ent } of prepared) {
    let placed = false;
    for (const c of clusters) {
      const r = sim(nt, c.nt);
      const shared = [];
      for (const e of ent) if (c.ent.has(e) && (df.get(e) || 0) <= rare_cap) shared.push(e);
      if (r >= 0.62 || (shared.length >= 2 && r >= 0.35)) {
        c.items.push(it);
        for (const e of ent) c.ent.add(e);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ nt, ent: new Set(ent), items: [it] });
  }

  clusters.forEach((c, i) => {
    // 存「名称(T层级)」而不只是 key：徽章要如实展示证据来自哪一层级，
    // 不能把社区转贴与官方发布笼统地说成「独立信源」。
    const names = [...new Set(c.items.map((m) => `${m.source_name}(T${m.tier})`))].sort();
    // 主链接取层级最高的成员（T1 < T2 < T3），同层级保持原有先后顺序
    const members = [...c.items].sort((x, y) => x.tier - y.tier);
    const urls = [...new Set(members.map((m) => m.url))];
    for (const m of c.items) {
      m.cluster_id = i;
      m.cluster_sources = names;
      m.cluster_urls = urls;
      m.cluster_best = members.length ? members[0].source_name : m.source_name;
    }
  });
  return clusters.map((c) => c.items);
}

/**
 * Primary link: the highest-tier source in the same story is preferred over the
 * item's own link.
 * @param {object} it
 * @returns {string}
 */
export function best_url(it) {
  return it.cluster_urls && it.cluster_urls.length ? it.cluster_urls[0] : it.url;
}

/**
 * Corroborating links: the primary link itself is excluded, so one URL is never
 * shown both as the original and as evidence.
 * @param {object} it
 * @param {number} [k] - how many alternatives to return.
 * @returns {string[]}
 */
export function other_urls(it, k = 2) {
  const main = best_url(it);
  return (it.cluster_urls || []).filter((u) => u !== main).slice(0, k);
}

/**
 * Top up the programmatic clustering with the LLM's `event` slugs, for the
 * "same thing, different words" cases literal title matching cannot see.
 *
 * parity: 只在同一 event 下有 2–4 条时归并（超过 4 条多为模型偷懒给了通用标识，
 * 宁可不动，避免虚增可信度）。归并结果会在徽章里标注「含语义归并」，与程序层
 * 可复现的交叉验证区分开。
 *
 * @param {object[]} items - items carrying `extra.event`.
 * @param {object|Function} [log] - `{ info, warning, error }` or a bare `(msg) => void`; may be omitted.
 * @returns {number} how many event groups were merged (0 when none qualified).
 */
export function merge_by_event(items, log) {
  const L = _mklog(log);
  /** @type {Map<string, object[]>} */
  const groups = new Map();
  for (const it of items) {
    const ev = (it.extra || {}).event || '';
    if (ev) {
      const g = groups.get(ev);
      if (g) g.push(it);
      else groups.set(ev, [it]);
    }
  }

  let merged = 0;
  for (const [ev, grp] of groups) {
    const keys = new Set(grp.map((m) => m.source_key));
    if (!(grp.length >= 2 && grp.length <= 4 && keys.size >= 2)) continue;
    /** @type {[number, string][]} */
    const pairs = [];
    for (const m of grp) {
      for (const u of m.cluster_urls && m.cluster_urls.length ? m.cluster_urls : [m.url]) {
        pairs.push([m.tier, u]);
      }
    }
    pairs.sort((x, y) => x[0] - y[0]); // 稳定排序：同层级保持原有先后
    const urls = [...new Set(pairs.map((p) => p[1]))];
    const srcs = [...new Set(grp.map((m) => `${m.source_name}(T${m.tier})`))].sort();
    let best = grp[0];
    for (const m of grp) if (m.tier < best.tier) best = m;
    for (const m of grp) {
      m.cluster_sources = srcs;
      m.cluster_urls = urls;
      m.cluster_best = best.source_name;
      m.extra.event_merged = true;
    }
    L.info(`       语义归并：${ev} ← ${srcs.join('、')}`);
    merged += 1;
  }
  return merged;
}

// ================================================================ 程序打分

/**
 * Absolute age in hours, on UTC instants.
 *
 * parity: `Item.age_hours()` in the Python treats an undated row as very old
 * rather than as brand new, so it can never win a recency comparison by accident.
 *
 * @param {object} it
 * @returns {number} non-negative hours, or 999 when there is no usable timestamp.
 */
function _ageHours(it) {
  const d = _asDate(it.published);
  if (!d) return 999;
  return Math.max(0, (Date.now() - d.getTime()) / 3600000);
}

/**
 * The LLM-free score every item always has available.
 *
 * parity: `tier_w` / 交叉验证 / 时效衰减 / 影响信号词 四项加权，再扣「无摘要惩罚」
 * —— 没有摘要的条目无法核实，程序层面先压一档，避免它靠「标题好听」挤进精选。
 *
 * The Python cached this on the item (`it.prog_score = programmatic_score(...)`,
 * `daily_ai_digest.py:1056`) and `final_score` reads that field. This function is
 * therefore pure: the caller stores the result (`it.prog_score = programmaticScore(...)`),
 * which is what makes `final_score` match Python line for line.
 *
 * @param {object} it
 * @param {number} window_hours - window the recency decay is measured against.
 * @returns {number}
 */
export function programmatic_score(it, window_hours) {
  const tier_w = ({ 1: 1.0, 2: 0.7, 3: 0.4 })[it.tier] ?? 0.4;
  const cross = Math.min((it.cluster_sources || []).length / 3.0, 1.0);
  const age = _ageHours(it);
  const recency = Math.max(0.0, 1.0 - age / window_hours);
  const hits = (it.title + ' ' + String(it.summary || '').slice(0, 300)).match(_SIGNAL_WORDS_G);
  const signal = Math.min((hits ? hits.length : 0) / 3.0, 1.0);
  const thin = String(it.summary || '').trim().length < 40 ? 0.15 : 0.0;
  return 0.35 * tier_w + 0.25 * cross + 0.20 * recency + 0.20 * signal - thin;
}

/**
 * Return `(badge, explanation)`. Credibility is computed programmatically and is
 * never handed to the LLM to invent.
 *
 * parity: 措辞用「经 N 个信源报道」，**不写**「独立信源」（那是过度断言）；
 * 语义归并出来的交叉印证必须与程序字面匹配区分开，读者才知道证据强度。
 *
 * @param {object} it
 * @param {string} [topic_hint] - accepted for call-site parity; unused by the
 *   Python original too.
 * @returns {[string, string]} badge and note.
 */
export function credibility(it, topic_hint = '') {
  const n = (it.cluster_sources || []).length;
  const tag = (it.extra || {}).event_merged ? '（含语义归并，非标题字面匹配）' : '';
  if (it.source_key === 'arxiv') {
    return ['🟢 原始论文', 'arXiv 预印本，未经同行评审；结论以论文原文为准'];
  }
  if (n >= 3) {
    return ['🟢 高度可信', `经 ${n} 个信源交叉报道：${(it.cluster_sources || []).join('、')}${tag}`];
  }
  if (n === 2) {
    return ['🟢 交叉验证', `经 2 个信源报道：${(it.cluster_sources || []).join('、')}${tag}`];
  }
  if (it.tier === 1) {
    return ['🟢 一手信源', `${it.source_name} 官方发布，绕过二手解读`];
  }
  if (it.tier === 2) {
    return ['🟡 单一来源', `仅 ${it.source_name} 一家报道，建议关注后续官方确认`];
  }
  return ['🟠 社区信号', '来自社区讨论，尚未获官方证实，仅作趋势参考'];
}

/**
 * Blend the LLM scores with the programmatic score.
 *
 * parity: `llm_topic === ''` 是「LLM 完全不可用」的哨兵值 -> 退回纯程序打分，
 * 否则一条没经过 LLM 的条目会被 0 分拖死。
 *
 * @param {object} it
 * @returns {number}
 */
export function final_score(it) {
  const llm = (0.55 * it.llm_importance + 0.45 * it.llm_novelty) / 10.0;
  if (!it.llm_topic) return it.prog_score; // LLM 完全不可用 -> 退回纯程序打分
  return 0.70 * llm + 0.30 * it.prog_score;
}

// ============================================================== 主题多样化选取

/**
 * "Same story" key for the diversity constraint: the LLM's merged event when it
 * exists, otherwise the programmatic cluster id. Programmatic clustering only
 * sees title similarity and cannot see "different titles, one event".
 * @param {object} it
 * @returns {string}
 */
export function story_key(it) {
  const ev = (it.extra || {}).event;
  if (ev) return 'e:' + ev;
  return 'c:' + it.cluster_id;
}

/**
 * Greedy selection that relaxes its constraints level by level:
 *   ① 信源互异 + 主题互异 + 事件互异（理想）  ② 信源互异 + 事件互异
 *   ③ 主题互异 + 事件互异  ④ 仅事件互异  ⑤ 无条件
 * Guard: a T3 community item needs ≥ 2 sources at levels ①–③; levels ④–⑤ lift it.
 *
 * @param {object[]} items
 * @param {number} [n]
 * @returns {object[]} at most `n` items.
 */
export function select_top(items, n = 3) {
  const ranked = [...items].sort((x, y) => final_score(y) - final_score(x));
  /** @type {object[]} */
  const picked = [];

  const ok = (it, { src, top, story, lone_t3 }) => {
    if (picked.some((p) => p === it)) return false;
    if (it.tier === 3 && (it.cluster_sources || []).length < 2 && !lone_t3) return false;
    if (story && picked.some((p) => story_key(it) === story_key(p))) return false;
    if (src && picked.some((p) => it.source_key === p.source_key)) return false;
    if (top && it.llm_topic && picked.some((p) => it.llm_topic === p.llm_topic)) return false;
    return true;
  };

  const levels = [
    { src: true, top: true, story: true, lone_t3: false },
    { src: true, top: false, story: true, lone_t3: false },
    { src: false, top: true, story: true, lone_t3: false },
    { src: false, top: false, story: true, lone_t3: true },
    { src: false, top: false, story: false, lone_t3: true },
  ];
  for (const lv of levels) {
    if (picked.length >= n) break;
    for (const it of ranked) {
      if (picked.length >= n) break;
      if (ok(it, lv)) picked.push(it);
    }
  }
  return picked.slice(0, n);
}

/**
 * Walk the time windows from narrow to wide and pick the first one that yields
 * `n` items at or above `min_imp`.
 *
 * parity: 宁可回溯一两天，也不拿重要性 < min_imp 的内容凑数。只有当最宽窗口也
 * 凑不出 n 条达标条目时，才退化为「该窗口内不设重要性门槛」，且仍然优先让达标
 * 条目排前面。
 *
 * @param {object[]} items
 * @param {number} n
 * @param {number[]} windows - candidate window sizes in hours.
 * @param {{ min_imp?: number }} [opts]
 * @returns {[object[], number]} the picked items and the window actually used.
 */
export function select_progressive(items, n, windows, { min_imp = 6.0 } = {}) {
  const now = Date.now();
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const sub = items.filter((it) => {
      const d = _asDate(it.published);
      return d !== null && now - d.getTime() <= w * 3600000;
    });
    const strong = sub.filter((it) => it.llm_importance >= min_imp);
    if (strong.length >= n) return [select_top(strong, n), w];
    if (i === windows.length - 1) {
      let picked = strong.length ? select_top(strong, n) : [];
      if (picked.length < n) {
        // 兜底：用窗口内其余条目补齐
        const taken = new Set(picked);
        picked = picked.concat(select_top(sub.filter((x) => !taken.has(x)), n - picked.length));
      }
      return [picked, w];
    }
  }
  return [[], windows[windows.length - 1]];
}

// ================================================================ LLM 解读

/**
 * Dynamic character budget (120–400) driven by importance and technical novelty.
 * @param {number} imp
 * @param {number} nov
 * @returns {number}
 */
export function char_budget(imp, nov) {
  const base = 0.55 * imp + 0.45 * nov; // 0-10
  let n;
  if (base >= 8.5) n = 400;
  else if (base >= 7.5) n = 350;
  else if (base >= 6.5) n = 290;
  else if (base >= 5.5) n = 230;
  else if (base >= 4.5) n = 175;
  else n = 120;
  if (nov >= 9.0) n += 40; // 技术新颖度加成
  return Math.max(120, Math.min(400, n));
}

/**
 * Characters that actually count against the budget (the three body fields).
 * @param {object} it
 * @returns {number}
 */
export function actual_len(it) {
  const ex = it.extra || {};
  return (
    String(ex.fact || '').length + String(ex.why || '').length + String(ex.impact || '').length
  );
}

/**
 * Split a total budget into the fact / why / impact sub-budgets.
 * parity: 分而治之比给一个总数有效得多。
 * @param {number} budget
 * @returns {[number, number, number]}
 */
export function split_budget(budget) {
  const f = Math.max(30, _round(budget * 0.22));
  const w = Math.max(50, _round(budget * 0.50));
  const i = Math.max(30, _round(budget * 0.28));
  return [f, w, i];
}

/**
 * Last line of defence: when the LLM still overshoots after several rewrites,
 * cut whole sentences along sentence boundaries (why → fact → impact), never
 * mid-sentence.
 *
 * parity: 只在超标 15% 以上时启动；按句子边界整句删除，因此不会产生病句。
 *
 * @param {object} it
 * @param {{ tolerance?: number }} [opts]
 * @returns {boolean} whether anything was cut.
 */
export function trim_to_budget(it, { tolerance = 1.15 } = {}) {
  const budget = _trunc(Number((it.extra || {}).budget) || 0);
  if (!budget) return false;
  const limit = _trunc(budget * tolerance);
  if (actual_len(it) <= limit) return false;

  for (const k of ['why', 'fact', 'impact']) {
    const cur = String((it.extra || {})[k] || '').trim();
    if (!cur) continue;
    const rest = actual_len(it) - cur.length;
    const parts = cur.split(/(?<=[。！？；!?;])/).filter((p) => p.trim());
    while (parts.length > 1 && rest + parts.join('').length > limit) parts.pop();
    it.extra[k] = parts.join('').trim();
    if (actual_len(it) <= limit) return true;
  }
  return actual_len(it) <= limit;
}

/**
 * Build the per-item material block handed to the interpretation LLM, including
 * the per-field sub-budgets.
 * @param {number} i - zero-based index, printed as the item number.
 * @param {object} it
 * @param {number} budget
 * @returns {string}
 */
function _build_block(i, it, budget) {
  const other = (it.cluster_sources || []).filter(
    (s) => !s.startsWith(`${it.source_name}(T`),
  );
  const d = _asDate(it.published);
  const when = d ? _cstStamp(d).slice(0, 16) : '时间未知';
  const [bf, bw, bi] = split_budget(budget);
  const b = [
    `--- 第 ${i} 条 ---\n`,
    `标题：${it.title}\n`,
    `字数预算：fact ≤ ${bf} 字，why ≤ ${bw} 字，impact ≤ ${bi} 字` +
      `（三者相加 ≤ ${budget} 字，这是硬上限，超出即为不合格）\n`,
    `信源：${it.source_name}（层级 T${it.tier}）\n`,
    `时间：${when}（北京时间）\n`,
  ];
  if (other.length) {
    b.push(`另有信源报道了同一事件（含层级标注）：${other.join('、')}\n`);
  }
  b.push(
    `主题簇：${TOPIC_LABELS[it.llm_topic] || '其他动态'}\n` +
      `重要性评分：${_g(it.llm_importance)}/10，技术新颖度：${_g(it.llm_novelty)}/10\n` +
      `原文摘要：${String(it.summary || '（该信源未提供摘要，请基于标题谨慎解读）').slice(0, 900)}\n`,
  );
  return b.join('');
}

// 模型常把「📌 事实：」这类段标题也写进字段值，渲染时会与模板的段标题重复。
const _LABEL_RE = new RegExp(
  '^\\s*(?:[\\u{1F4CC}\\u{1F50D}\\u{1F3AF}\\u{2696}]\\uFE0F?\\s*' +
    '(?:事实|为什么重要|对你的影响|影响|存疑点|可信度|解读)?\\s*[:：]?\\s*)' +
    '|^\\s*(?:事实|为什么重要|对你的影响|存疑点|可信度)\\s*[:：]\\s*',
  'u',
);

/**
 * Strip a section label the model wrongly wrote into a field value. Loops until
 * the string stops changing so "📌 事实：事实：" cannot survive one pass.
 * @param {string} s
 * @returns {string}
 */
function _strip_label(s) {
  let cur = String(s ?? '');
  let prev = null;
  while (prev !== cur) {
    prev = cur;
    cur = cur.replace(_LABEL_RE, '');
  }
  return cur.trim();
}

/**
 * Tidy a Chinese headline's whitespace: keep one space between CJK and Latin,
 * drop spaces that sit next to CJK; cap at 30 characters.
 * @param {string} s
 * @returns {string}
 */
function _tidy_headline(s) {
  let out = String(s ?? '').trim().replace(/\s+/g, ' ');
  out = out.replace(/\s+(?=[\u4e00-\u9fff])/g, '');
  out = out.replace(/(?<=[\u4e00-\u9fff])\s+/g, '');
  return out.trim().slice(0, 30);
}

/**
 * Write the LLM's JSON rows back into `item.extra`.
 *
 * parity: `replace = true`（重写轮）只要该条返回了任意非空字段就整条替换，
 * 避免新旧文本混排；`headline` 空则退回 `title.slice(0, 24)`；兜底保证渲染端
 * 永远拿得到字符串。
 *
 * @param {object[]} picked
 * @param {number[]} idxs - row numbers to update (0-based).
 * @param {string} raw - raw LLM output.
 * @param {{ replace?: boolean }} [opts]
 * @returns {void}
 */
function _apply_rows(picked, idxs, raw, { replace = false } = {}) {
  const data = _extract_json(raw);
  /** @type {Map<number, object>} */
  const got = new Map();
  const rows = Array.isArray(data.items) ? data.items : [];
  for (const x of rows) {
    if (x && typeof x === 'object' && String(x.i ?? '').replace(/^-/, '').match(/^\d+$/)) {
      got.set(Number(x.i), x);
    }
  }
  for (const i of idxs) {
    const row = got.get(i) || {};
    /** @type {Record<string, string>} */
    const vals = {};
    for (const k of ['fact', 'why', 'impact', 'doubt']) {
      vals[k] = _strip_label(String(row[k] ?? '').trim());
    }
    const hl = _tidy_headline(String(row.headline ?? ''));
    if (hl) picked[i].extra.headline = hl;
    else if (!picked[i].extra.headline) picked[i].extra.headline = String(picked[i].title).slice(0, 24);

    if (replace && Object.values(vals).some((v) => v)) {
      for (const k of ['fact', 'why', 'impact']) picked[i].extra[k] = vals[k];
      if (vals.doubt) picked[i].extra.doubt = vals.doubt;
    } else {
      for (const [k, v] of Object.entries(vals)) {
        if (v) picked[i].extra[k] = v;
      }
    }
    // 兜底，保证渲染端永远拿得到字符串
    if (!picked[i].extra.fact) picked[i].extra.fact = '（解读生成失败）';
    for (const k of ['why', 'impact']) {
      if (picked[i].extra[k] === undefined) picked[i].extra[k] = '';
    }
    if (picked[i].extra.doubt === undefined) picked[i].extra.doubt = '暂无明显疑点';
  }
}

const INTERP_SYSTEM = `你是一位严谨的 AI 技术分析师，为一位中国资深工程师撰写每日情报解读。

铁律（违反即为失败）：
1. **只依据给定材料**。严禁编造数字、基准分数、时间、机构名、产品名。
2. 材料不足以支撑判断时，直接写「原文未提供足够信息」，不要猜测、不要脑补。
3. 不做投资建议，不做夸大预测（禁止"将颠覆""必将取代"这类措辞）。
4. 全程中文。术语可保留英文原词。
5. **字数必须遵守标注的预算**：fact+why+impact 的中文字符总数应落在目标值的 -15% ~ +10% 区间内。
6. 只输出 JSON，不要任何解释文字。`;

const INTERP_USER_TMPL = `请为下面 {n} 条新闻各写一段解读。

{blocks}

对每一条，输出五个字段：
- "headline"：用**一句中文**把这个事件说清楚，≤ 24 个中文字符，不要重复原文标题的英文，
  不要写成"XX 发布"这类空壳，要包含关键信息（谁 + 做了什么 + 关键数字/对象）。
  例：「Anthropic 因无法控制智能体，切断内部评测联网」。
  **除了模型名、公司名、产品名等专有名词，不要夹杂英文单词**（写「诱发」不要写 "elicit"）。
- "fact"：📌 事实。用 1-2 句说清发生了什么。只复述原文，禁止任何超出原文的推断。
- "why"：🔍 为什么重要。给出机制层面的解读：改变了什么、和已有工作是什么关系、因果链条是什么。禁止空泛形容词。
- "impact"：🎯 对你的影响。明确给出「值得立刻试 / 值得关注等待 / 可以忽略」的判断，并说明理由，要具体可操作。
- "doubt"：⚖️ 存疑点。这条信息有哪些不确定之处？（如：仅厂商自述无第三方验证、缺基准数据、未开源、时间表含糊等）。若无明显疑点写「暂无明显疑点」。

【字数硬约束】每条新闻的标题行下方都标注了该条的「字数预算」。
"fact"、"why"、"impact" 三个字段**各自不得超过**标注的上限，三者相加不得超过总上限。
**总字数是最重要的标准**；个别字段略微超出一点、但总长仍落在范围内，是可以接受的。
写完之后请默数总中文字符数再核对一次；超了就删掉修饰性形容词与重复表述。
"headline" 与 "doubt" 字段不计入字数。为什么重要(why)应占最大比重，但在上限内取舍——宁可少写，不可超写。

输出严格 JSON：
{{"items":[{{"i":编号,"headline":"...","fact":"...","why":"...","impact":"...","doubt":"..."}}]}}
必须覆盖全部 {n} 条。`;

const INTERP_RETRY_TMPL = `你上一版对下列各条的解读**字数超标/不足**，需要重写。

{blocks}

重写要求（严格）：
{instr}

其余写作规则与上一轮相同（只依据原始材料、不编造、四段结构）。
"headline" 请沿用上一版（若上一版没有，就补一个 ≤24 字的中文标题）。
输出严格 JSON，且只包含上述需要重写的编号：
{{"items":[{{"i":编号,"headline":"...","fact":"...","why":"...","impact":"...","doubt":"..."}}]}}`;

// ================================================================== LLM 调用

/**
 * POST one chat completion and return the assistant message content.
 *
 * parity: 失败重试 3 次，间隔 3s / 6s；重试次数与超时直接取 LLM 子配置上的
 * `max_retries` / `timeout`（Python 传的就是 `cfg["llm"]`，默认值 3 / 180s）。
 * The port also accepts `timeoutMs` in milliseconds, so the caller's config can
 * stay in JS units without silently losing the timeout.
 *
 * @param {object} cfg - the LLM sub-config: `{ base_url, api_key, model,
 *   max_retries?, timeout? | timeoutMs? }`.
 * @param {object[]} messages - OpenAI-style chat messages.
 * @param {{ json_mode?: boolean, max_tokens?: number, temperature?: number,
 *   timeoutMs?: number }} [opts]
 * @returns {Promise<string>} assistant content.
 * @throws {Error} the last failure, after `max_retries` attempts.
 */
export async function llm_chat(cfg, messages, {
  json_mode = false,
  max_tokens = 4000,
  temperature = 0.3,
  timeoutMs = 180000,
} = {}) {
  const url = String(cfg.base_url).replace(/\/+$/, '') + '/chat/completions';
  /** @type {Record<string, unknown>} */
  const payload = {
    model: cfg.model,
    messages,
    stream: false,
    temperature,
    max_tokens,
  };
  if (json_mode) payload.response_format = { type: 'json_object' };

  const tries = Number.isFinite(Number(cfg.max_retries)) ? Number(cfg.max_retries) : 3;
  // `timeout` is seconds (Python); `timeoutMs` is milliseconds (this port).
  const cfgTimeoutMs = Number.isFinite(Number(cfg.timeoutMs))
    ? Number(cfg.timeoutMs)
    : (Number.isFinite(Number(cfg.timeout)) ? Number(cfg.timeout) * 1000 : 180000);
  const effectiveTimeout = Math.min(timeoutMs, cfgTimeoutMs);

  let last = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(effectiveTimeout),
      });
      const text = await res.text();
      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = JSON.parse(text);
      return data.choices[0].message.content;
    } catch (e) {
      last = e;
      _plainLog(`LLM 调用失败(第 ${attempt + 1} 次): ${String(e && e.message ? e.message : e).slice(0, 160)}`);
      if (attempt < tries - 1) await _sleep(3000 * (attempt + 1));
    }
  }
  throw last || new Error('LLM 调用失败');
}

/** Warning sink for `llm_chat`, which the contract gives no `log` parameter.
 * Silenced: the module may not write to stdout on its own (no top-level effects),
 * and the caller already turns a thrown error into its own log line.
 * @param {string} _msg */
function _plainLog(_msg) {}

/**
 * `time.sleep(seconds)` for the retry backoff.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dig a JSON object out of raw LLM output: strip a ```json fence, try a plain
 * parse, then fall back to the first balanced `{...}` block.
 * @param {string} text
 * @returns {object}
 */
function _extract_json(text) {
  let t = String(text ?? '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to the brace scan */
  }

  // Anchored non-greedy scan first (the Python's `\{.*\}` is greedy, which is what
  // makes it "first ... last" — for the single-object replies we get, the two agree).
  const greedy = t.match(/\{[\s\S]*\}/);
  if (greedy) {
    try {
      return JSON.parse(greedy[0]);
    } catch {
      /* try the balanced scan */
    }
  }

  // First balanced {...}: safe for replies that carry prose with braces around the JSON.
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return {};
}

const RANK_SYSTEM = `你是一位严谨的 AI 领域技术情报分析师，为一位中国工程师做每日情报筛选。

你的任务：给候选新闻逐条打分。评判标准：

【重要性 importance 0-10】
- 9-10：改变行业格局（顶级实验室重大模型发布、重大监管落地、关键技术范式突破）
- 7-8：重要的产品/模型/论文发布，值得行业内所有人知道
- 5-6：有一定价值，但影响面有限（小版本更新、单一厂商商业动作）
- 1-4：噪音、软文、营销稿、纯观点评论、与 AI 技术无关

【技术新颖度 novelty 0-10】
- 9-10：提出了新的方法/架构/训练范式，或刷新了公认基准
- 7-8：在已有方向上做出了实质性推进
- 5-6：工程优化、组合创新、规模化验证
- 1-4：无技术创新（商业新闻、政策新闻、产品改版填 1-3 即可）

【严格扣分项】
- 标题党、PR 软文、内容空洞的"AI 将改变一切"式评论、无具体技术信息的融资通稿。
- **二手转述**：只引用/摘抄别家报道、自身没有独立信息增量的链接贴（标题形如 "Quoting X"、
  "Links for …"、"Weekly roundup"）。重要性按**它所转述的那件事**打，但**新颖度一律 ≤3**；
  这类条目的 fact 必须写成"某媒体援引某家报道"，不要把转述方写成事发方。
- 与 AI 技术无关的纯基建、人事变动、会议/活动预告。
- **摘要为空的条目**：无从核实，重要性一律 ≤4、新颖度 ≤5，不应进入精选。

【主题簇 topic】只能取以下之一：
model(模型发布) / research(研究突破) / product(产品工具) / opensource(开源生态) /
industry(产业资本) / policy(政策安全) / other

【同一事件归并 event】给每条一个「事件短标识」：3-6 个英文小写单词，用连字符连接，
例如 "anthropic-agent-internet-cutoff"、"openai-gpt6-release"、"arxiv-encrypted-backdoor"。
**凡是在讲同一件事的条目，无论标题措辞、无论来自哪个信源，都必须填完全相同的字符串。**
判断标准是"这件事是否是同一个新闻事件"，而不是"是否属于同一主题"：
同属 policy 但讲的是两件不同的事，就要用两个不同的 event。
这条信息会被用来避免同一天推送两条实际上重复的新闻，请认真逐条比对。

只输出 JSON，不要任何解释文字。`;

const RANK_USER_TMPL = `今天是 {today}。以下是 {n} 条候选（编号 | 信源 | 层级 | 标题 | 摘要）。

{listing}

请对**每一条**打分，输出严格 JSON：
{{"items":[{{"i":编号,"imp":重要性0-10,"nov":新颖度0-10,"topic":"主题簇","event":"事件短标识"}}]}}
必须覆盖全部 {n} 条，不得遗漏。`;

/**
 * Score every pool item with one LLM call and write the results back in place:
 * `llm_importance`, `llm_novelty`, `llm_topic`, `extra.event`.
 *
 * parity: 漏掉的条目保持哨兵值语义（Python 补 5 分并计遗漏数）；`event` 只留
 * `[a-z0-9-]` 并截断 60 字符 —— 它会被当作跨源「同一件事」的键。
 *
 * @param {object} cfg - LLM config.
 * @param {object[]} items - candidates, mutated in place.
 * @param {string} today - e.g. `2026年10月13日`.
 * @param {object|Function} [log] - log object or bare sink function.
 * @returns {Promise<void>}
 */
export async function llm_rank(cfg, items, today, log) {
  const L = _mklog(log);
  const listing = items
    .map(
      (it, i) =>
        `${i} | ${it.source_name} | T${it.tier} | ${String(it.title).slice(0, 110)} | ` +
        `${String(it.summary || '').slice(0, 190)}`,
    )
    .join('\n');
  const raw = await llm_chat(
    cfg,
    [
      { role: 'system', content: RANK_SYSTEM },
      {
        role: 'user',
        content: RANK_USER_TMPL.replace('{today}', today)
          .replace('{n}', String(items.length))
          .replace('{listing}', listing),
      },
    ],
    { json_mode: true, max_tokens: 6000 },
  );

  const data = _extract_json(raw);
  /** @type {Map<number, object>} */
  const got = new Map();
  const rows = Array.isArray(data.items) ? data.items : [];
  for (const x of rows) {
    if (x && typeof x === 'object' && String(x.i ?? '').replace(/^-/, '').match(/^\d+$/)) {
      got.set(Number(x.i), x);
    }
  }

  let missing = 0;
  items.forEach((it, i) => {
    const row = got.get(i);
    if (row) {
      const imp = Number(row.imp ?? 5);
      const nov = Number(row.nov ?? 5);
      if (Number.isFinite(imp) && Number.isFinite(nov)) {
        it.llm_importance = imp;
        it.llm_novelty = nov;
      } else {
        it.llm_importance = 5.0;
        it.llm_novelty = 5.0;
      }
      const topic = String(row.topic ?? '').trim().toLowerCase();
      it.llm_topic = topic in TOPIC_LABELS ? topic : 'other';
      const ev = String(row.event ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '');
      it.extra.event = ev.slice(0, 60);
    } else {
      it.llm_importance = 5.0;
      it.llm_novelty = 5.0;
      it.llm_topic = 'other';
      it.extra.event = '';
      missing += 1;
    }
  });

  const n_ev = new Set(items.map((it) => it.extra.event).filter(Boolean)).size;
  L.info(`LLM 排序完成：${items.length - missing} 条已打分，${missing} 条默认补 5 分，归并为 ${n_ev} 组事件`);
}

/**
 * Write the interpretation for each picked item: one initial call, then up to
 * `max_retry` surgical rewrite rounds that name only the offending fields, then
 * a programmatic sentence-boundary trim as the last resort.
 *
 * parity: 三层字数控制，一层都不能少 —— ① 子预算写进材料块；② 超标只列超标字段
 * 并要求「其余字段保持不变」；③ 仍超标就按句子边界整句删除。判据只看总字数
 * （用户看到的是总长），子预算只作为提示词里的引导。
 *
 * @param {object} cfg - LLM config.
 * @param {object[]} picked - the selected items, mutated in place.
 * @param {object|Function} [log] - log object or bare sink function.
 * @param {{ max_retry?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function llm_interpret(cfg, picked, log, { max_retry = 2 } = {}) {
  const L = _mklog(log);
  for (const it of picked) {
    it.extra.budget = char_budget(it.llm_importance, it.llm_novelty);
    if (it.extra.fact === undefined) it.extra.fact = '';
  }

  const idxs = picked.map((_, i) => i);
  let raw = await llm_chat(
    cfg,
    [
      { role: 'system', content: INTERP_SYSTEM },
      {
        role: 'user',
        content: INTERP_USER_TMPL.replace('{n}', String(picked.length)).replace(
          '{blocks}',
          picked.map((it, i) => _build_block(i, it, it.extra.budget)).join(''),
        ),
      },
    ],
    { json_mode: true, max_tokens: 8000, temperature: 0.5 },
  );
  _apply_rows(picked, idxs, raw);

  for (let attempt = 0; attempt < max_retry; attempt++) {
    const bad = [];
    picked.forEach((it, i) => {
      const len = actual_len(it);
      if (len > it.extra.budget * 1.10 || len < 0.78 * it.extra.budget) bad.push(i);
    });
    if (!bad.length) break;
    L.info(`       字数校正第 ${attempt + 1} 轮：重写第 ${bad.map((i) => i + 1).join('、')} 条`);
    const lines = [];
    for (const i of bad) {
      const it = picked[i];
      const budget = it.extra.budget;
      const [bf, bw, bi] = split_budget(budget);
      const cur = {};
      for (const k of ['fact', 'why', 'impact']) cur[k] = String(it.extra[k] ?? '').length;
      const total = actual_len(it);
      if (total > budget) {
        const parts = [
          ['fact', bf],
          ['why', bw],
          ['impact', bi],
        ]
          .filter(([k, lim]) => cur[k] > lim)
          .map(([k, lim]) => `${k} ${cur[k]}→≤${lim} 字`)
          .join('，');
        lines.push(
          `- 第 ${i} 条：上一版 ${total} 字，超出上限 ${budget} 字。` +
            `需压缩的字段：${parts || 'why'}。` +
            `做法：先写下必须保留的 2-3 个核心信息点，只围绕它们成句，` +
            `删去背景铺垫与形容词。**其余字段保持与上一版一致，不要一起改短。**`,
        );
      } else {
        lines.push(
          `- 第 ${i} 条：上一版 ${total} 字，低于 ${budget} 字的合理下界。` +
            `请把 why 扩写到 ≤${bw} 字（补充机制与因果细节，不要写套话），` +
            `fact ≤${bf} 字、impact ≤${bi} 字，总长仍需 ≤${budget} 字。`,
        );
      }
    }
    const retryBlocks = bad.map((i) => _build_block(i, picked[i], picked[i].extra.budget)).join('');
    raw = await llm_chat(
      cfg,
      [
        { role: 'system', content: INTERP_SYSTEM },
        {
          role: 'user',
          content: INTERP_RETRY_TMPL.replace('{blocks}', retryBlocks).replace('{instr}', lines.join('\n')),
        },
      ],
      { json_mode: true, max_tokens: 8000, temperature: 0.3 },
    );
    _apply_rows(picked, bad, raw, { replace: true });
  }

  // 兜底：多轮重写仍超标时程序化裁剪，保证发出去的字数不会失控。
  picked.forEach((it, i) => {
    if (trim_to_budget(it)) {
      L.warning(
        `       第 ${i + 1} 条 ${max_retry} 轮重写后仍超标，已按句子边界程序化裁剪至 ` +
          `${actual_len(it)} 字（上限 ${it.extra.budget} 字）`,
      );
    }
  });
}
