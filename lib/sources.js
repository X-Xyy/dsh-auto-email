/**
 * sources.js — 信源定义与采集器（`ai-daily-digest/sources.py` 的原生 Node 移植）
 *
 * 设计要点（全部基于 2026-10-12 本机实测结论，逐条照抄 Python 原版）：
 *   * huggingface.co 本机不可达      -> 走 hf-mirror.com 镜像
 *   * arXiv RSS 返回空 feed          -> 改用 arXiv 官方 API
 *   * Anthropic 无 RSS               -> 解析 /news 页面 (含 <time> 与摘要)
 *   * news.ycombinator.com 不可达    -> 走 hn.algolia.com API
 *   * 机器之心全站被 WAF 拦截         -> 不采用（已与用户确认）
 *   * GitHub trending 403            -> 不采用
 * 每个请求 3 次指数退避重试，单源失败不影响整体。
 *
 * 零运行时依赖：只用 `node:` 内置模块与全局 `fetch`。Node 标准库没有 XML 解析器，
 * 本文件的 `_parseFeed` 自带一个紧凑的标记读取器（见该函数注释）。
 */

import { createItem } from './item.js';

// ---------------------------------------------------------------- 基础设施

/** 浏览器 UA 串，与 Python 原版逐字一致（不少源按 UA 拦爬虫）。 */
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 默认请求头，与 Python 原版逐字一致。 */
export const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const TAG_RE = /<[^>]+>/g;
const WS_RE = /\s+/g;

/**
 * 去 HTML 标签、反转义实体、压缩空白。
 *
 * @param {string|null|undefined} s - 原始片段，可为空。
 * @param {number} [limit=900] - 结果最大长度（字符串切片，按 UTF-16 码元）。
 * @returns {string} 清洗后的纯文本；输入为空时返回 `''`。
 */
export function clean_text(s, limit = 900) {
  if (!s) return '';
  let out = String(s).replace(TAG_RE, ' ');
  out = unescapeEntities(out);
  out = out.replace(WS_RE, ' ').trim();
  return out.slice(0, limit);
}

// ------------------------------------------------------ 实体反转义（html.unescape）

// CPython html.unescape 先扫数字实体再扫命名实体，且命名实体取最长匹配。
// 只保留原版真正会命中的常用表；未知实体原样保留（`&unknownentity;` 不变）。
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7',
  deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7',
  frac12: '\u00bd', sup2: '\u00b2', sup3: '\u00b3', laquo: '\u00ab',
  raquo: '\u00bb', sect: '\u00a7', para: '\u00b6', dagger: '\u2020',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  larr: '\u2190', rarr: '\u2192', harr: '\u2194', infin: '\u221e',
  ne: '\u2260', le: '\u2264', ge: '\u2265', shy: '\u00ad',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
};

// 长名排在前面：CPython 的实体正则就是按名字长度倒序拼的，`&ampx;` 会先试 `ampx` 再退到 `amp`。
// 分号可选（`html.unescape` 的 `;?`），未知名字因为不在表里自然匹配不上、原样保留。
const NAMED_ENTITY_RE = new RegExp(
  `&(${Object.keys(NAMED_ENTITIES)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .join('|')});?`,
  'g',
);

/**
 * 反转义 HTML 实体：数字实体 `&#NNN;` / `&#xHH;` 与常用命名实体。
 * 命名实体按**最长前缀**匹配，所以 `&ampx;` 会解成 `&x;`；完全未知的名字原样保留。
 *
 * @param {string} s - 含实体的文本。
 * @returns {string} 反转义后的文本。
 */
function unescapeEntities(s) {
  s = s.replace(/&#(?:[0-9]+|[xX][0-9a-fA-F]+);?/g, (whole) => {
    const hex = whole[2] === 'x' || whole[2] === 'X';
    // 数字实体的开头固定是 `&#`，十六进制还多一个 `x`，所以数字从下标 3 起算。
    const body = whole.slice(hex ? 3 : 2).replace(/;$/, '');
    const code = parseInt(body, hex ? 16 : 10);
    // CPython 把非法码位替换成 U+FFFD；String.fromCodePoint 会抛错，故手动挡。
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '\ufffd';
    if (code >= 0xd800 && code <= 0xdfff) return '\ufffd';
    return String.fromCodePoint(code);
  });
  // `&` 后连续字母数字才算实体名；正则已按长名优先，这里只需处理名字比已知实体长的情形。
  return s.replace(NAMED_ENTITY_RE, (whole, name) => {
    const hadSemi = whole.endsWith(';');
    const bare = hadSemi ? whole.slice(0, -1) : whole;
    const hit = NAMED_ENTITIES[name];
    if (hit !== undefined) return hit;
    for (let n = name.length - 1; n >= 2; n--) {
      const cand = NAMED_ENTITIES[name.slice(0, n)];
      if (cand !== undefined) return cand + bare.slice(1 + n);
    }
    return whole;
  });
}

/**
 * 剥掉 CDATA 包裹，保留内部原文（XML 里 CDATA 就是字面文本，不再解实体）。
 *
 * @param {string} s - 原始标签内文。
 * @returns {string} 去 CDATA 后的文本。
 */
function stripCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// ------------------------------------------------------ URL 规范化（urllib.parse 移植）

// RFC 3986 的 scheme 语法；Python urlsplit 只认这个形状的 `xxx:` 前缀。
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/;
const NETLOC_START_RE = /^[/?#]/;

/**
 * `urllib.parse.urlsplit` 的最小移植。刻意不用 WHATWG `URL`：后者会偷偷
 * 补斜杠、拒绝无 scheme 的串，与 Python 的宽松行为对不上
 * （实测原版 `canonical_url("not a url at all")` 返回 `"https:///not a url at all"`）。
 *
 * @param {string} u - 原始 URL。
 * @returns {{scheme: string, netloc: string, path: string, query: string, fragment: string}} 五段式。
 */
function urlSplit(u) {
  let rest = String(u);
  let scheme = '';
  let fragment = '';
  let query = '';

  const hi = rest.indexOf('#');
  if (hi >= 0) {
    fragment = rest.slice(hi + 1);
    rest = rest.slice(0, hi);
  }
  const qi = rest.indexOf('?');
  if (qi >= 0) {
    query = rest.slice(qi + 1);
    rest = rest.slice(0, qi);
  }
  const sm = SCHEME_RE.exec(rest);
  if (sm) {
    scheme = sm[1].toLowerCase();
    rest = rest.slice(sm[0].length);
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const si = rest.indexOf('/');
    if (si < 0) {
      netloc = rest;
      rest = '';
    } else {
      netloc = rest.slice(0, si);
      rest = rest.slice(si);
    }
  }
  return { scheme, netloc, path: rest, query, fragment };
}

/**
 * `urllib.parse.urlunsplit` 的移植。
 * 注意 Python 的写法是 `if netloc or (url[:2] == '//')`：只要 scheme 非空就必定补 `//`，
 * 所以 `urlunsplit(('https','','/p','',''))` 得到 `https:///p`（三斜杠），照抄。
 *
 * @param {[string, string, string, string, string]} parts - `[scheme, netloc, path, query, fragment]`。
 * @returns {string} 拼回的 URL。
 */
function urlUnsplit(parts) {
  const [scheme, netloc, path, query, fragment] = parts;
  let out = scheme ? scheme + ':' : '';
  if (netloc || scheme) out += '//' + netloc;
  out += path;
  if (query) out += '?' + query;
  if (fragment) out += '#' + fragment;
  return out;
}

/**
 * `urllib.parse.quote_plus` 的移植（保留 `A-Za-z0-9_.-~`，空格变 `+`）。
 *
 * @param {string} s - 待编码文本。
 * @returns {string} 百分号编码结果。
 */
function quotePlus(s) {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

/**
 * `urllib.parse.unquote_plus` 的移植（`+` 还原为空格）。
 *
 * @param {string} s - 已编码文本。
 * @returns {string} 解码结果；非法百分号转义时原样返回（Python 会抛错，这里选择更稳的兜底）。
 */
function unquotePlus(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '));
  } catch {
    return String(s);
  }
}

/**
 * `urllib.parse.parse_qsl` 的移植：按 `&` 切、`=` 分键值、键值都做 unquote_plus。
 * `parse_qsl` 默认 `keep_blank_values=False`，所以**不带 `=` 的字段被整条丢弃**
 * （`?empty=&x=1` -> `[['empty',''],['x','1']]`）。
 *
 * @param {string} q - 查询串（不含 `?`）。
 * @returns {Array<[string, string]>} 键值对数组，保持原顺序。
 */
function parseQsl(q) {
  const out = [];
  if (!q) return out;
  for (const field of String(q).split('&')) {
    if (!field) continue;
    const eq = field.indexOf('=');
    if (eq < 0) continue;
    out.push([unquotePlus(field.slice(0, eq)), unquotePlus(field.slice(eq + 1))]);
  }
  return out;
}

/**
 * URL 规范化：去追踪参数、去 fragment、统一小写主机名。
 *
 * @param {string} u - 原始 URL。
 * @returns {string} 规范化后的 URL；输入为空时返回 `''`。
 */
export function canonical_url(u) {
  if (!u) return '';
  const trimmed = String(u).trim();
  let p;
  try {
    p = urlSplit(trimmed);
  } catch {
    return trimmed;
  }
  const DROP_EXACT = new Set(['ref', 'source', 'fbclid', 'gclid', 'spm', 'from']);
  const pairs = parseQsl(p.query);
  const drop = new Set();
  for (const [k] of pairs) {
    const lk = k.toLowerCase();
    if (lk.startsWith('utm_') || DROP_EXACT.has(lk)) drop.add(k);
  }
  const q = pairs
    .filter(([k]) => !drop.has(k))
    .map(([k, v]) => quotePlus(k) + '=' + quotePlus(v))
    .join('&');
  const path = p.path.replace(/\/+$/, '') || '/';
  // parity: 原版用 netloc.lower() 整体小写，端口/用户信息也一起被压平，照抄不改。
  return urlUnsplit([p.scheme || 'https', p.netloc.toLowerCase(), path, q, '']);
}

// ---------------------------------------------------------------- HTTP

/**
 * 从 `Retry-After` 头解析等待秒数。
 *
 * @param {string} v - 头的原始值。
 * @returns {number|null} 秒数；不是纯数字时返回 `null`（由调用方退避）。
 */
function parseRetryAfter(v) {
  const s = String(v || '').trim();
  // parity: Python 用 `ra.replace(".","",1).isdigit()` 判断，接受的形状就是可选小数点 + 数字。
  if (/^\d*\.?\d+$/.test(s)) {
    const n = parseFloat(s);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 带指数退避的 GET；429 时尊重 `Retry-After`。全部失败则抛最后一个异常。
 *
 * @param {string} url - 完整 URL（含查询串）。
 * @param {object} [opts] - 选项。
 * @param {number} [opts.tries=3] - 总尝试次数。
 * @param {number} [opts.timeout=25] - 单次请求超时（秒）。
 * @param {object} [opts.headers] - 追加/覆盖的请求头。
 * @returns {Promise<string>} 响应体文本。
 * @throws {Error} 全部尝试失败时抛出；HTTP 失败的错误信息里保留状态码。
 */
export async function httpGet(url, { tries = 3, timeout = 25, headers } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reqHeaders = headers ? { ...HEADERS, ...headers } : HEADERS;
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: reqHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout * 1000),
      });
      if (r.status === 200) return await r.text();
      last = new Error(`HTTP ${r.status}`);
      if (r.status === 429 && i < tries - 1) {
        const ra = parseRetryAfter(r.headers.get('Retry-After'));
        const wait = ra === null ? 8.0 * (i + 1) : ra;
        // 无论服务器给的是秒数还是 HTTP-date，都 clamp 到 3–60 秒。
        await sleep(Math.min(Math.max(wait, 3.0), 60.0) * 1000);
        continue;
      }
      if (r.status === 403 || r.status === 404 || r.status === 410) break; // 确定性失败，重试无意义
    } catch (e) {
      last = e;
    }
    // parity: Python 的 `time.sleep((2 ** i) + random.uniform(0, 0.6))` 以**秒**为单位
    // （首次退避约 1.54 秒），而 `setTimeout` 收毫秒 —— 必须乘 1000，否则退避会塌成 1.5 毫秒。
    if (i < tries - 1) await sleep(((2 ** i) + Math.random() * 0.6) * 1000);
  }
  throw last || new Error('unknown fetch error');
}

// ---------------------------------------------------------------- 日期解析

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// `email._parseaddr` 的时区缩写表（值是以分钟为单位的偏移）。原版同时用到大小写两种拼法。
// 注意它与数字偏移是**互斥**的两条路：`Mon, 13 Oct 2026 09:47:05 EST` 用这张表，
// 而 `... 09:47:05 -0500 (EST)` 用数字偏移、括号里的名字被当注释丢掉。
const TZ_OFFSETS = {
  UT: 0, UTC: 0, GMT: 0, Z: 0,
  AST: -240, ADT: -180,
  EST: -300, EDT: -240,
  CST: -360, CDT: -300,
  MST: -420, MDT: -360,
  PST: -480, PDT: -420,
};

/**
 * 解析 RFC 822 / RFC 2822 日期（如 `Mon, 13 Oct 2026 09:47:05 +0800`）。
 * 刻意不用 `Date.parse`：它对非标形状的容错因实现而异，这里按 Python
 * `email.utils.parsedate_to_datetime` 的形状手工解析。
 *
 * @param {string} s - 日期串。
 * @returns {Date|null} UTC 时刻；形状不符时返回 `null`。
 */
function parseRfc822(s) {
  let t = String(s).trim();
  const ci = t.lastIndexOf('(');
  if (ci >= 0 && t.endsWith(')')) t = t.slice(0, ci).trim(); // 去尾部 `(PDT)` 注释
  const parts = t.split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return null;

  let idx = 0;
  if (/^[A-Za-z]{3,}$/.test(parts[0]) && !MONTHS.includes(parts[0].slice(0, 3).toLowerCase())) {
    idx = 1; // 前导星期名
  }
  const dayStr = parts[idx];
  const monStr = parts[idx + 1];
  const yearStr = parts[idx + 2];
  if (dayStr === undefined || monStr === undefined || yearStr === undefined) return null;
  if (!/^\d{1,2}$/.test(dayStr) || !/^\d{2,4}$/.test(yearStr)) return null;
  const mon = MONTHS.indexOf(String(monStr).slice(0, 3).toLowerCase());
  if (mon < 0) return null;

  let hh = 0;
  let mi = 0;
  let ss = 0;
  const tm = parts[idx + 3];
  if (tm) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(tm);
    if (!m) return null;
    hh = Number(m[1]);
    mi = Number(m[2]);
    ss = m[3] === undefined ? 0 : Number(m[3]);
  }
  let offMin = 0;
  const tz = parts[idx + 4];
  // parity with `parsedate_tz`：偏移量优先看第 5 个 token 的数字形状，否则查时区缩写表。
  const zm = tz === undefined ? null : /^([+-])(\d{2})(\d{2})?$/.exec(tz);
  if (zm) {
    // `+HHMM` -> HH*60+MM 分钟；`+HH` -> **HH 分钟**（原始实现按分钟位解释，`+08` 即 +8 分钟，
    // 不是 +8 小时；照抄这个 bug）。
    offMin = (zm[1] === '-' ? -1 : 1) * (zm[3] === undefined ? Number(zm[2]) : Number(zm[2]) * 60 + Number(zm[3]));
  } else if (tz !== undefined && TZ_OFFSETS[tz.toUpperCase()] !== undefined) {
    offMin = TZ_OFFSETS[tz.toUpperCase()];
  }
  // parity: `parsedate_to_datetime` 用 `time.acl` 的世纪规则给两位年份定世纪（>=69 视作 19xx）。
  const ynum = Number(yearStr);
  const year = yearStr.length <= 2 ? (ynum >= 69 ? 1900 + ynum : 2000 + ynum) : ynum;
  // parity: `parsedate_to_datetime` 交 `datetime(...)` 构造，字段越界是 ValueError -> None，
  // 不像 `Date.UTC` 那样 roll over（`25:00:00` 必须返回 null，而不是次日 01:00；
  // `Feb 29 2026` 也必须返回 null）。`validFields` 用的就是 `mon`，所以这里传 1 基月份。
  if (!validFields(year, mon + 1, Number(dayStr), hh, mi, ss)) return null;
  const ms = Date.UTC(year, mon, Number(dayStr), hh, mi, ss);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - offMin * 60000);
}

/**
 * 解析固定格式的 ISO/英文日期，语义对齐 Python `datetime.strptime`
 * （支持 `%z` 的 `+HHMM` 与带冒号的 `+HH:MM` 两种写法；不做宽松补全）。
 *
 * @param {string} s - 日期串。
 * @returns {Date|null} UTC 时刻；格式不匹配时返回 `null`。
 */
function parseIsoLike(s) {
  const t = String(s).trim();
  // parity: `strptime` 的格式串是逐字面量匹配的 —— `T` 是字面量（空格不接受、`9:47` 不补零也不接受），
  // 且 `.` 与 `%f` 只出现在 `...%fZ` 那一条，所以小数秒后面必须正好跟一个 `Z`。
  let m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d+)[Zz]$/.exec(t);
  if (m) {
    const [, Y, Mo, D, H, Mi, S, frac] = m;
    if (!validFields(+Y, +Mo, +D, +H, +Mi, +S)) return null;
    const msField = Math.floor(Number(`0.${frac}`) * 1000);
    return new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S, msField));
  }
  // parity: `strptime` 的字面量是用大小写不敏感的正则比的，所以 `Z` 也吃 `z`。
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})[Zz]$/.exec(t);
  if (m) {
    const [, Y, Mo, D, H, Mi, S] = m;
    if (!validFields(+Y, +Mo, +D, +H, +Mi, +S)) return null;
    return new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S));
  }
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:?\d{2})$/.exec(t);
  if (m) {
    const [, Y, Mo, D, H, Mi, S, tz] = m;
    if (!validFields(+Y, +Mo, +D, +H, +Mi, +S)) return null;
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    return new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S) - offMin * 60000);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(t);
  if (m) {
    const [, Y, Mo, D, H, Mi, S] = m;
    if (!validFields(+Y, +Mo, +D, +H, +Mi, +S)) return null;
    return new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S));
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const [, Y, Mo, D] = m;
    if (!validFields(+Y, +Mo, +D, 0, 0, 0)) return null;
    return new Date(Date.UTC(+Y, +Mo - 1, +D));
  }
  m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(t);
  if (m) {
    const mon = fullMonthIndex(m[1]);
    if (mon < 0) return null;
    if (!validFields(+m[3], mon + 1, +m[2], 0, 0, 0)) return null;
    return new Date(Date.UTC(+m[3], mon, +m[2]));
  }
  return null;
}

/**
 * 校验日期时间字段的取值范围（对齐 `strptime` / `datetime(...)` 的拒绝行为，
 * 而不是让它 roll over）。日期要按真实日历校验：`Feb 29, 2026` 必须被拒。
 *
 * @param {number} y - 年。
 * @param {number} mo - 月（1-12）。
 * @param {number} d - 日（1-31，且必须存在于该月）。
 * @param {number} h - 时。
 * @param {number} mi - 分。
 * @param {number} s - 秒。
 * @returns {boolean} 全部在合法范围内为 `true`。
 */
function validFields(y, mo, d, h, mi, s) {
  if (!(y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return false;
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 60)) return false;
  // roll-over 探测：`Date.UTC` 会把 2 月 30 日溢到 3 月，溢出即说明该日不存在。
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/**
 * 英文月份名（全称或三字母缩写）转 0 基月份。
 *
 * @param {string} name - 月份名。
 * @returns {number} 0-11；不认识时返回 `-1`。
 */
function fullMonthIndex(name) {
  const n = String(name).toLowerCase();
  for (let i = 0; i < MONTHS.length; i++) {
    if (n === MONTHS[i] || n.startsWith(MONTHS[i])) {
      const full = ['january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december'][i];
      if (n === full || n === MONTHS[i]) return i;
    }
  }
  return -1;
}

/**
 * 兼容 RFC822 / ISO8601 两种日期写法，统一返回 UTC 的 `Date`。
 *
 * @param {string|null|undefined} s - 日期串。
 * @returns {Date|null} UTC 时刻；无法解析时返回 `null`（绝不返回 Invalid Date）。
 */
export function parse_date(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  const rfc = parseRfc822(t);
  if (rfc) return rfc;
  return parseIsoLike(t);
}

// ---------------------------------------------------------------- 极简 XML 读取

// 标签名允许命名空间前缀与连字符：`dc:date`、`content:encoded`、`media:description`。
const NAME = '[A-Za-z_][\\w.:\\-]*';
// 开标签整体；属性用 `[^>]*` 吃掉（属性值里含 `>` 的极端情况不值得为它引入回溯风险）。
const OPTAG = new RegExp(`<(${NAME})((?:\\s[^>]*)?)/?>`, 'g');

/**
 * 取块内首个 `<tag ...>…</tag>` 或自闭合 `<tag .../>` 的文本内容。
 * 命名空间前缀被忽略（`dc:date` 与 `date` 等价），与 `_xml()` 的做法一致。
 *
 * @param {string} block - 一个 `<item>` / `<entry>` 块的原文。
 * @param {string} tag - 目标标签名，可带前缀。
 * @returns {string|null} 文本（含 CDATA 原文）；标签不存在时返回 `null`，自闭合返回 `''`。
 */
function getTagText(block, tag) {
  const local = String(tag).split(':').pop().toLowerCase();
  OPTAG.lastIndex = 0;
  let m;
  while ((m = OPTAG.exec(block)) !== null) {
    if (m[1].split(':').pop().toLowerCase() !== local) continue;
    const closing = new RegExp(`</${escapeRe(m[1])}\\s*>`, 'i');
    const tail = block.slice(m.index + m[0].length);
    const cm = closing.exec(tail);
    if (cm) return tail.slice(0, cm.index);
    if (m[0].endsWith('/>')) return '';
    // 未闭合的开标签（畸形 feed）：当作空标签处理，避免越界吞掉后续块。
    return '';
  }
  return null;
}

/**
 * 收集块内某标签的每一个出现（`<link rel="self"/>` 会有多个，只能全收再挑）。
 *
 * @param {string} block - 块原文。
 * @param {string} tag - 标签名。
 * @returns {Array<{attrs: object, text: string, selfClosing: boolean}>} 按出现顺序。
 */
function getAllTags(block, tag) {
  const local = String(tag).split(':').pop().toLowerCase();
  const out = [];
  OPTAG.lastIndex = 0;
  let m;
  while ((m = OPTAG.exec(block)) !== null) {
    if (m[1].split(':').pop().toLowerCase() !== local) continue;
    const selfClosing = m[0].endsWith('/>');
    let text = '';
    if (!selfClosing) {
      const closing = new RegExp(`</${escapeRe(m[1])}\\s*>`, 'i');
      const cm = closing.exec(block.slice(m.index + m[0].length));
      // 先剥 CDATA 再解实体（与 `textContent` 同序），否则 URL 会把 `<![CDATA[` 当成正文。
      if (cm) text = stripCdata(block.slice(m.index + m[0].length, m.index + m[0].length + cm.index));
    }
    out.push({ attrs: parseAttrs(m[2] || ''), text, selfClosing });
  }
  return out;
}

/**
 * 解析开标签里的属性串。
 *
 * @param {string} s - `<tag` 之后的原文（含前导空格）。
 * @returns {object} 属性名到值的映射；无引号的裸值也接受。
 */
function parseAttrs(s) {
  const out = {};
  const re = /([\w.:\-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out[m[1].toLowerCase()] = unescapeEntities(m[3] !== undefined ? m[3]
      : m[4] !== undefined ? m[4] : m[5]);
  }
  return out;
}

/**
 * 转义正则元字符（标签名回填进 `</tag>` 匹配时用）。
 *
 * @param {string} s - 待转义文本。
 * @returns {string} 可用于 `new RegExp` 的文本。
 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 剥掉块内的注释，免得注释里的 `<item>` 之类字样污染匹配。
 *
 * @param {string} s - 原文。
 * @returns {string} 去注释后的文本。
 */
function stripComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * 抽出一类块（`<item>…</item>` 或 `<entry>…</entry>`）。
 * 非贪婪 + 惰性量词，锚定在块边界上，避免回溯爆炸。
 *
 * @param {string} content - 整个 feed。
 * @param {string} blockTag - `item` 或 `entry`。
 * @returns {string[]} 块原文数组。
 */
function extractBlocks(content, blockTag) {
  const src = stripComments(content);
  const re = new RegExp(`<${blockTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${blockTag}\\s*>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/**
 * 把一段标签内文转成纯文本：剥 CDATA、解实体。
 *
 * @param {string|null} raw - 标签内文。
 * @returns {string} 去 CDATA 并反转义后的文本。
 */
function textContent(raw) {
  if (raw === null || raw === undefined) return '';
  return unescapeEntities(stripCdata(raw));
}

// ---------------------------------------------------------------- 通用 RSS

/**
 * 解析 RSS 2.0 / RSS 1.0(RDF) / Atom 文本，转成条目数组。
 *
 * @param {object} src - 信源描述对象（`SOURCES` 的成员）。
 * @param {string} text - feed 原文。
 * @param {number} max_items - 最多产出条数。
 * @returns {object[]} `createItem()` 记录数组。
 */
function _parseFeed(src, text, max_items) {
  let blocks = extractBlocks(text, 'item');
  if (!blocks.length) blocks = extractBlocks(text, 'entry');
  const out = [];
  for (const block of blocks.slice(0, max_items)) {
    const title = clean_text(textContent(getTagText(block, 'title')), 300);

    let url = '';
    const links = getAllTags(block, 'link');
    if (links.length) {
      // `urllib`/`xml.etree` 都用 `<link>`；自闭合（Atom）取 `href`，成对（RSS）取正文。
      const pickText = (l) => (l.selfClosing ? (l.attrs.href || '') : textContent(l.text));
      // 契约 §3 明确要求：Atom 常有多个 `<link>`，优先 `rel="alternate"`，无 `rel` 取第一个 `href`。
      // 注意这与 Python 原版**故意不同**——原版无条件取首个 `<link>`，于是 `rel="self"` 排前面时
      // 会把自指 URL 当正文链接（Simon Willison 的 Atom 正是这个形状），见交付报告。
      const best = links.find((l) => l.attrs.rel === 'alternate')
        || links.find((l) => l.attrs.rel === undefined)
        || links[0];
      url = String(pickText(best) || '').trim();
    }
    if (!url) {
      const guid = textContent(getTagText(block, 'guid')).trim();
      if (guid) url = guid;
    }

    let summary = '';
    for (const k of ['description', 'summary', 'content', 'encoded']) {
      const raw = getTagText(block, k);
      if (raw) {
        summary = clean_text(textContent(raw));
        break;
      }
    }

    let pub = null;
    for (const k of ['pubDate', 'published', 'updated', 'date']) {
      const raw = textContent(getTagText(block, k)).trim();
      if (raw) {
        pub = parse_date(raw);
        if (pub) break;
      }
    }

    if (title && url) {
      out.push(createItem({
        source_key: src.key,
        source_name: src.name,
        tier: src.tier,
        title,
        url: canonical_url(url),
        summary,
        published: pub,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 日志注入

let _LOG_FN = null;

/**
 * 注入信息性日志函数（`fetch_rss` 的 AI 过滤等会用到）。
 *
 * @param {Function} fn - 接收单个字符串的日志函数。
 * @returns {void}
 */
export function setLogger(fn) {
  _LOG_FN = typeof fn === 'function' ? fn : null;
}

/**
 * 可选的信息性日志；未注入 logger 时静默。
 *
 * @param {string} msg - 日志正文。
 * @returns {void}
 */
function log_note(msg) {
  if (_LOG_FN) _LOG_FN(msg);
}

/**
 * 通用 RSS 2.0 / RSS 1.0(RDF) / Atom 抓取解析器。
 *
 * @param {object} src - 信源描述对象（需要 `url`、`key`、`name`、`tier`；可带 `filter_ai`）。
 * @param {object} [opts] - 选项。
 * @param {number} [opts.max_items=60] - 最多产出条数。
 * @returns {Promise<object[]>} `createItem()` 记录数组。
 */
export async function fetch_rss(src, { max_items = 60 } = {}) {
  const text = await httpGet(src.url);
  const out = _parseFeed(src, text, max_items);

  // 综合性博客（如 Simon Willison）会混入非 AI 的纯工程/基建帖，按 AI 关键词过滤
  if (src.filter_ai) {
    const kept = out.filter((it) => AI_RE.test(it.title + ' ' + (it.summary || '')));
    const dropped = out.length - kept.length;
    if (dropped) {
      log_note(`${src.name}: AI 关键词过滤剔除 ${dropped} 条非 AI 内容`);
    }
    return kept;
  }
  return out;
}

// ---------------------------------------------------------------- arXiv API

/** arXiv API 查询模板，`{n}` 由调用方替换（同 Python 的 `ARXIV_QUERY`）。 */
export const ARXIV_QUERY = 'http://export.arxiv.org/api/query?'
  + 'search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG+OR+cat:cs.CV'
  + '&sortBy=submittedDate&sortOrder=descending&max_results={n}';

/**
 * arXiv 官方 API 替代已失效的 RSS。
 *
 * @param {object} src - 信源描述对象。
 * @param {object} [opts] - 选项。
 * @param {number} [opts.max_items=22] - 最多产出条数。
 * @returns {Promise<object[]>} `createItem()` 记录数组，`extra` 带 `categories` / `authors`。
 */
export async function fetch_arxiv(src, { max_items = 22 } = {}) {
  const url = ARXIV_QUERY.replace('{n}', String(Math.max(max_items * 2, 40)));
  const text = await httpGet(url, { tries: 4, timeout: 35 });
  const blocks = extractBlocks(text, 'entry');
  const out = [];
  for (const block of blocks.slice(0, max_items)) {
    const title = clean_text(textContent(getTagText(block, 'title')), 300);
    const summary = clean_text(textContent(getTagText(block, 'summary')), 900);
    const pub = parse_date(textContent(getTagText(block, 'published')).trim());
    const url2 = textContent(getTagText(block, 'id')).trim();
    const cats = getAllTags(block, 'category').map((c) => c.attrs.term).filter((t) => t !== undefined);
    if (!(title && url2)) continue;
    const authors = getAllTags(block, 'author')
      .map((a) => clean_text(textContent(getTagText(a.text, 'name'))))
      .slice(0, 4);
    out.push(createItem({
      source_key: src.key,
      source_name: src.name,
      tier: src.tier,
      title,
      url: canonical_url(url2),
      summary,
      published: pub,
      extra: { categories: cats.slice(0, 4), authors },
    }));
  }
  return out;
}

// ---------------------------------------------------------------- Anthropic

/** Anthropic 新闻列表页（无官方 RSS）。 */
export const ANTHROPIC_NEWS = 'https://www.anthropic.com/news';

const _A_HREF = /<a[^>]+href="(\/news\/[a-z0-9][a-z0-9\-]*)"/gi;
// 该页有两种卡片布局，标题/摘要所在元素不同，逐个兜底：
//   ① FeaturedGrid  -> <h2 class="headline-4 ...">标题</h2> + <p class="body-3 serif ...">摘要</p>
//   ② PublicationList -> <span class="...__title ...">标题</span>，无摘要
const _TITLE_PATS = [
  /<h2[^>]*>([\s\S]*?)<\/h2>/gi,
  /<h3[^>]*>([\s\S]*?)<\/h3>/gi,
  /<span[^>]*class="[^"]*__title[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
  /<div[^>]*class="[^"]*__title[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
];
const _TIME_RE = /<time[^>]*>([\s\S]*?)<\/time>/gi;
const _P_RE = /<p[^>]*class="[^"]*body[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
const _SUBJ_RE = /<span[^>]*class="[^"]*__subject[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;

/**
 * 取第一个捕获组（内部辅助）。
 *
 * @param {RegExp} re - 带捕获组的正则（会被重置 lastIndex）。
 * @param {string} s - 目标文本。
 * @returns {string|null} 首个捕获组；无匹配返回 `null`。
 */
function firstGroup(re, s) {
  re.lastIndex = 0;
  const m = re.exec(s);
  return m ? m[1] : null;
}

/**
 * Anthropic 无官方 RSS，解析 `/news` 列表页（含 `<time>` 与摘要段落）。
 *
 * @param {object} src - 信源描述对象。
 * @param {object} [opts] - 选项。
 * @param {number} [opts.max_items=12] - 最多产出条数。
 * @returns {Promise<object[]>} `createItem()` 记录数组，`extra.category` 为版块名。
 */
export async function fetch_anthropic(src, { max_items = 12 } = {}) {
  const h = await httpGet(ANTHROPIC_NEWS, { timeout: 30 });
  const hits = [];
  _A_HREF.lastIndex = 0;
  let hm;
  while ((hm = _A_HREF.exec(h)) !== null) hits.push({ index: hm.index, slug: hm[1] });

  const out = [];
  const seen = new Set();
  for (let i = 0; i < hits.length; i++) {
    if (out.length >= max_items) break;
    const slug = hits[i].slug;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : start + 4000;
    const block = h.slice(start, end);

    let title = '';
    for (const pat of _TITLE_PATS) {
      const raw = firstGroup(pat, block);
      if (raw !== null) {
        title = clean_text(raw, 300);
        if (title) break;
      }
    }
    if (!title) continue;

    const dm = firstGroup(_TIME_RE, block);
    const pub = dm !== null ? parse_date(clean_text(dm, 60)) : null;

    const pm = firstGroup(_P_RE, block);
    const summary = pm !== null ? clean_text(pm, 900) : '';

    const extra = {};
    const sm = firstGroup(_SUBJ_RE, block);
    if (sm !== null) extra.category = clean_text(sm, 40);

    out.push(createItem({
      source_key: src.key,
      source_name: src.name,
      tier: src.tier,
      title,
      url: canonical_url('https://www.anthropic.com' + slug),
      summary,
      published: pub,
      extra,
    }));
  }
  return out;
}

// ------------------------------------------------- 摘要补全（供解读使用）

const _META_PATS = [
  /<meta[^>]+property="og:description"[^>]+content="([^"]{20,900})"/i,
  /<meta[^>]+name="description"[^>]+content="([^"]{20,900})"/i,
  /<meta[^>]+content="([^"]{20,900})"[^>]+property="og:description"/i,
  /<meta[^>]+content="([^"]{20,900})"[^>]+name="description"/i,
];

/**
 * 抓取文章页的 `og:description` / `meta description`，作为缺失摘要的兜底。
 *
 * @param {string} url - 文章 URL。
 * @param {object} [opts] - 选项。
 * @param {number} [opts.timeout=20] - 单次请求超时（秒）。
 * @returns {Promise<string>} 摘要；失败时返回 `''`，不抛错。
 */
export async function fetch_meta_description(url, { timeout = 20 } = {}) {
  let text;
  try {
    text = await httpGet(url, { tries: 2, timeout });
  } catch {
    return '';
  }
  for (const pat of _META_PATS) {
    const m = pat.exec(text);
    if (m) return clean_text(unescapeEntities(m[1]), 700);
  }
  return '';
}

// ---------------------------------------------------------------- Hacker News

/** HN 直连不可达，走 Algolia 搜索 API。 */
export const HN_ALGOLIA = 'https://hn.algolia.com/api/v1/search';

/** AI 关键词正则；只用于 simonw 与 HN 的过滤。 */
export const AI_RE = /\b(?:ai|a\.i\.|llm|llms|gpt|chatgpt|claude|gemini|openai|anthropic|deepmind|transformer|neural|machine[\s\-]?learning|deep[\s\-]?learning|agent|agents|agentic|rag|embedding|embeddings|diffusion|mistral|llama|qwen|deepseek|hugging[\s\-]?face|inference|fine[\s\-]?tun\w*|prompt|chatbot|copilot|mcp|rlhf|tokenizer|pytorch|tensorflow|whisper|sora|midjourney|stable[\s\-]?diffusion|reasoning[\s\-]?model|multimodal|vlm|quantiz\w+|gguf|vllm|llama\.cpp|model[\s\-]?context[\s\-]?protocol|ai[\s\-]?safety|alignment|benchmark)\b/i;

/**
 * Hacker News 直连不可达，改用 Algolia 搜索 API（按热度取，再按 AI 关键词过滤）。
 *
 * @param {object} src - 信源描述对象。
 * @param {object} [opts] - 选项。
 * @param {number} [opts.max_items=30] - 最多产出条数。
 * @param {number} [opts.window_hours=30] - 只看最近多少小时内创建的 story。
 * @returns {Promise<object[]>} 按 points 降序的 `createItem()` 记录数组。
 */
export async function fetch_hn(src, { max_items = 30, window_hours = 30 } = {}) {
  const since = Math.floor(Date.now() / 1000) - window_hours * 3600;
  const out = [];
  const seen = new Set();
  for (const minPts of [150, 60]) {
    let payload;
    try {
      const params = new URLSearchParams({
        tags: 'story',
        numericFilters: `points>${minPts},created_at_i>${since}`,
        hitsPerPage: '60',
      });
      const text = await httpGet(HN_ALGOLIA + '?' + params.toString(), { timeout: 25 });
      payload = JSON.parse(text);
    } catch {
      continue;
    }
    for (const hit of payload.hits || []) {
      const title = clean_text(hit.title || '', 300);
      if (!title || seen.has(title)) continue;
      if (!AI_RE.test(title)) continue;
      seen.add(title);
      const ts = hit.created_at_i;
      const pub = ts ? new Date(ts * 1000) : null;
      const url = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
      out.push(createItem({
        source_key: src.key,
        source_name: src.name,
        tier: src.tier,
        title,
        url: canonical_url(url),
        summary: clean_text(hit.story_text || '', 400),
        published: pub,
        extra: {
          points: hit.points || 0,
          comments: hit.num_comments || 0,
          hn_discussion: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        },
      }));
    }
  }
  out.sort((a, b) => (b.extra.points || 0) - (a.extra.points || 0));
  return out.slice(0, max_items);
}

// ---------------------------------------------------------------- 信源总表

/** 信源总表：10 个源，顺序 / 层级 / 条数上限 / URL 全部照抄 `sources.py`。 */
export const SOURCES = [
  // ---- T1 一手官方 / 原始论文 -------------------------------------------
  { key: 'openai', name: 'OpenAI 官方', tier: 1, kind: 'rss',
    url: 'https://openai.com/news/rss.xml', max: 60 },
  { key: 'anthropic', name: 'Anthropic 官方', tier: 1, kind: 'anthropic',
    url: ANTHROPIC_NEWS, max: 12 },
  { key: 'deepmind', name: 'Google DeepMind', tier: 1, kind: 'rss',
    url: 'https://deepmind.google/blog/rss.xml', max: 40 },
  { key: 'hf_blog', name: 'Hugging Face 博客', tier: 1, kind: 'rss',
    url: 'https://hf-mirror.com/blog/feed.xml', max: 40 }, // 镜像
  { key: 'arxiv', name: 'arXiv 论文', tier: 1, kind: 'arxiv',
    url: ARXIV_QUERY, max: 22 },

  // ---- T2 权威媒体 ------------------------------------------------------
  { key: 'qbitai', name: '量子位', tier: 2, kind: 'rss',
    url: 'https://www.qbitai.com/feed/', max: 30 },
  { key: 'techcrunch', name: 'TechCrunch AI', tier: 2, kind: 'rss',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/', max: 30 },
  { key: 'mittr', name: 'MIT Tech Review', tier: 2, kind: 'rss',
    url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', max: 25 },
  { key: 'simonw', name: 'Simon Willison', tier: 2, kind: 'rss',
    url: 'https://simonwillison.net/atom/everything/', max: 30,
    filter_ai: true },

  // ---- T3 社区信号（永不单独成条）--------------------------------------
  { key: 'hn', name: 'Hacker News', tier: 3, kind: 'hn',
    url: HN_ALGOLIA, max: 30 },
];

const _FETCHERS = {
  rss: fetch_rss,
  arxiv: fetch_arxiv,
  anthropic: fetch_anthropic,
  hn: fetch_hn,
};

/**
 * 按 kind 分派到对应采集器，并换算各自的参数。
 *
 * @param {object} src - 信源描述对象。
 * @param {number} window_hours - 时间窗（小时）。
 * @param {number} arxiv_max - arXiv 条数上限。
 * @param {number} hn_max - HN 条数上限。
 * @returns {Promise<object[]>} 条目数组。
 */
function _run_source(src, window_hours, arxiv_max, hn_max) {
  const fn = _FETCHERS[src.kind];
  const kw = { max_items: src.max };
  if (src.kind === 'arxiv') kw.max_items = arxiv_max;
  if (src.kind === 'hn') {
    return fn(src, { max_items: hn_max, window_hours: window_hours + 6 });
  }
  return fn(src, kw);
}

/**
 * 顺序采集；返回 `{ items, errors }`。单源失败被隔离。
 *
 * 失败的信源在其余信源跑完后**再试一次**（间隔 `retry_delay` 秒）。理由：本机网络对
 * Google 域名（deepmind.google / blog.google）与 export.arxiv.org 存在间歇性
 * ConnectionReset / SSL 失败，同一分钟内重试往往就能成功；顺序采集让这次重试的
 * 代价只是几十秒，却能把一个 T1 信源从「今天没有」救回来。
 *
 * @param {object} [opts] - 选项。
 * @param {number} [opts.window_hours=26] - 时间窗（小时）。
 * @param {number} [opts.arxiv_max=22] - arXiv 条数上限。
 * @param {number} [opts.hn_max=30] - HN 条数上限。
 * @param {number} [opts.retry_delay=20] - 首轮失败信源的统一重试等待（秒）。
 * @param {Function} [opts.log] - 日志函数，默认静默。
 * @returns {Promise<{items: object[], errors: string[]}>} 全部条目与错误描述列表。
 */
export async function fetch_all({
  window_hours = 26, arxiv_max = 22, hn_max = 30, retry_delay = 20, log = () => {},
} = {}) {
  const items = [];
  let errors = [];
  setLogger(log);

  const failed = [];
  for (const src of SOURCES) {
    try {
      const got = await _run_source(src, window_hours, arxiv_max, hn_max);
      items.push(...got);
      log(`  [OK ] ${src.name.padEnd(20)} ${String(got.length).padStart(3)} 条`);
    } catch (e) {
      const name = e && e.name ? e.name : 'Error';
      const msg = e && e.message ? e.message : String(e);
      errors.push(`${src.name}: ${name}: ${msg.slice(0, 120)}`);
      log(`  [ERR] ${src.name.padEnd(20)} ${name}: ${msg.slice(0, 90)}`);
      failed.push(src);
    }
  }

  if (failed.length) {
    log(`  ↻ ${failed.length} 个信源首轮失败，${retry_delay.toFixed(0)} 秒后统一重试…`);
    await new Promise((r) => setTimeout(r, retry_delay * 1000));
    for (const src of failed) {
      try {
        const got = await _run_source(src, window_hours, arxiv_max, hn_max);
        items.push(...got);
        errors = errors.filter((m) => !m.startsWith(`${src.name}:`));
        log(`  [OK*] ${src.name.padEnd(20)} ${String(got.length).padStart(3)} 条（重试成功）`);
      } catch (e) {
        const name = e && e.name ? e.name : 'Error';
        const msg = e && e.message ? e.message : String(e);
        log(`  [ERR] ${src.name.padEnd(20)} 重试仍失败：${name}: ${msg.slice(0, 70)}`);
      }
    }
  }

  return { items, errors };
}
