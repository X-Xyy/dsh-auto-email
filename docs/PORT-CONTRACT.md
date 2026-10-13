# dsh-auto-email — JS 移植契约

## 0. 这是什么

`dsh-auto-email` 是一个 Python 参考实现的**原生 Node 重写版**，封装成 DSH Desktop 插件。

> 那份 Python 参考实现**不随本仓库发布**（它含作者本机的专属配置）。下文出现「Python 参考实现」时指的就是它；本文件记录的是它定下的行为约定，读者只依本文件与 `lib/` 里的注释即可理解全部规则。

**Python 版是行为基准，不是灵感来源。** 算法、阈值、正则、LLM prompt 原文、邮件文案措辞、emoji，全部逐条对齐。移植工作不是重新设计；看到 Python 里任何「看起来可以改进」的地方，保持原样并在注释里记一句 `// parity: <为什么原版这么做>`。

## 1. 硬性约束

1. **零运行时依赖。** 只允许 `node:` 内置模块（`node:fs`、`node:path`、`node:crypto`、`node:url`…）与全局 `fetch` / `AbortSignal` / `TextDecoder`。**不得**出现 `rss-parser`、`nodemailer`、`cheerio`、`xml2js`、`axios`、`node-fetch` 等任何包，`package.json` 里也不许加 `dependencies`。
2. **ESM。** 用 `import` / `export`。不写 `"use strict"`，不写 `require`。
3. **模块顶层零副作用。** 不许在顶层读文件、发请求、`process.exit`、`console.log`。需要日志就接收调用方注入的 `log` 函数。
4. **风格：** 2 空格缩进、单引号、行尾不留空格、文件末尾一个换行。中文文案原样保留（含 emoji 与全角标点）。
5. **每个 `export` 都要有 JSDoc**：一句话说清做什么，`@param` / `@returns`。内部函数在逻辑不显然处写一行注释。
6. **不要发明数据结构。** 所有条目一律用 `lib/item.js` 的 `createItem()`（见 `lib/item.js:1`，已是最终形态，不要改）。
7. **时间基准。** 沿用 Python 里的 `CST = UTC+8` 语义：窗口比较用 UTC 瞬时，展示用 `Asia/Shanghai`。不要依赖运行机器的本地时区。

## 2. 共享数据结构

`createItem()` 的字段与语义见 `lib/item.js`。要点：

- `published` 是 `Date` 或 `null`（**绝不**用 `Invalid Date`）。
- `extra` 是自由袋，已知键：`category`、`event`、`headline`、`budget`、`aged`、`event_merged`。
- `llm_importance === 0` / `llm_novelty === 0` / `llm_topic === ''` 表示「还没经过 LLM。」所有下游判断必须先看这个哨兵值。
- `cluster_sources` 存的是**带层级后缀的显示串**（`"量子位(T2)"`），不是裸信源 key。这是刻意的：徽章要如实标注层级。
- `cluster_best` 是集群中层级最高成员的信源名 —— 文章真正的出处。

配置对象 `cfg` 沿用 Python 的键名，这样两边可以互相 diff：

```js
cfg = {
  llm:    { base_url, api_key, model },
  digest: { top_n, window_hours, fallback_window_hours, min_importance,
            max_candidates_for_ranking, arxiv_max_items, hn_max_items, send_when_empty },
  email:  { /* 只给 mail.js 用，digest.js 不碰 */ },
}
```

## 3. 子任务 A —— `lib/sources.js`

对照 `sources.py` 逐函数移植。**导出面（JS 一律用对象参数）：**

```js
export const UA                     // 同 Python 的 UA 串
export const HEADERS                // { 'User-Agent': UA, ... }，同 Python
export function clean_text(s, limit = 900) -> string
export function canonical_url(u) -> string
export function parse_date(s) -> Date | null
export async function httpGet(url, { tries = 3, timeout = 25, headers } = {}) -> string   // 返回响应体文本
export const SOURCES                // 10 个信源描述对象，字段与 Python 的 SOURCES 一一对应
export const AI_RE                  // 只用于 simonw 的 AI 关键词过滤
export const ARXIV_QUERY            // 同 Python 的模板串
export function setLogger(fn)       // fetch_rss 内部要打日志时用；未设置则静默
export async function fetch_rss(src, { max_items = 60 } = {}) -> Item[]
export async function fetch_arxiv(src, { max_items = 22 } = {}) -> Item[]
export async function fetch_anthropic(src, { max_items = 12 } = {}) -> Item[]
export async function fetch_hn(src, { max_items = 30, window_hours = 30 } = {}) -> Item[]
export async function fetch_meta_description(url, { timeout = 20 } = {}) -> string
export async function fetch_all({ window_hours = 26, arxiv_max = 22, hn_max = 30, retry_delay = 20, log = () => {} } = {})
  -> { items: Item[], errors: string[] }
```

**移植时必须保住的细节**（都在 Python 里，别漏）：

- `_get` / `httpGet`：指数退避；**专门处理 HTTP 429** —— 读 `Retry-After` 头，不是数字就退避 `8.0 * (i + 1)` 秒，clamp 到 3–60 秒后**重试**；对 403/404/410 **立即放弃**（确定性失败重试无意义）。HTTP 失败要抛错，错误信息里保留状态码。
- `fetch_rss`：支持 RSS 2.0 / RSS 1.0(RDF) / Atom 三种。`src.filter_ai` 为真时按 `AI_RE` 过滤（simonw 用的）。
- `fetch_arxiv`：用 `ARXIV_QUERY` 模板，`max(max_items * 2, 40)` 条请求，tries=4、timeout=35。
- `fetch_anthropic`：**没有官方 RSS**，抓 `https://www.anthropic.com/news` 页面正则解析。页面上有**两种卡片布局**：FeaturedGrid 用 `<h2>`，PublicationList 用 `<span class="...__title...">`。标题正则要按 Python 的 `_TITLE_PATS` 顺序兜底（h2 → h3 → `__title` span → div），日期用 `<time>`（格式 `%b %d, %Y`，例如 `Oct 8, 2026`，解析时**必须显式按月名英文解析**，不要交给宽松的 `Date.parse`），分类写进 `it.extra.category`。实测该页约 429 KB、11 个 `/news/<slug>` 链接、能解析出 10 条。
- `fetch_hn`：用 hn.algolia.com API，`tags=story` + `numericFilters=points>N,created_at_i>TS`；Python 里的分数门槛与时间窗换算照抄。
- `fetch_meta_description`：og:description / name=description 共 4 个正则（两种属性顺序），失败**返回空串不抛错**，结果过 `html.unescape` + `clean_text(..., 700)`。
- `fetch_all`：单源失败必须隔离；首轮记录失败的源，其余源跑完后统一 `sleep(retry_delay)` 再重试一轮；重试成功的从错误列表里摘掉，并打 `[OK*] <名字> ... 重试成功`。
- `SOURCES` 的 10 个源与顺序、层级、`max` 条数、URL，全部照抄 `sources.py:380` 起的那张表。注意 Hugging Face 走的是镜像 `https://hf-mirror.com/blog/feed.xml`（主站被封），Hacker News 走 Algolia API（官方 RSS 超时）。

**XML 解析怎么替代 `xml.etree`：** Node 标准库没有 XML 解析器，写一个**紧凑但稳健**的正则/markup 读取器，要求：

- 按 `<item>…</item>` 与 `<entry>…</entry>` 抽块（非贪婪、锚定，避免回溯爆炸）。
- 块内取首个 `<tag ...>…</tag>` 或自闭合 `<tag .../>`，容忍命名空间前缀（`dc:date`、`content:encoded`、`media:description`）。
- 剥 CDATA，解实体：`&amp; &lt; &gt; &quot; &#39; &apos;` 以及数字实体 `&#NNN;` / `&#xHH;`。
- Atom 的 `<link>` 常见自闭合且**有多个**（`rel="alternate"` / `rel="self"`），优先取 `rel="alternate"`，无 rel 取第一个 `href`。
- `title` / `content` 里可能带 HTML，交给 `clean_text`。

**这一段会被真实信源检验**，请务必用 `node` 直接跑一遍（网络可用）验证：OpenAI（`https://openai.com/news/rss.xml`）、量子位（`https://www.qbitai.com/feed/`）、TechCrunch AI、MIT Tech Review AI、Google DeepMind（`https://deepmind.google/blog/rss.xml`）、Hugging Face 镜像、Simon Willison（Atom，`https://simonwillison.net/atom/everything/`）、hnrss 或 Algolia、arXiv API、Anthropic 页面 —— 每个都要能解析出条目且 `published` 不是 `null`（arXiv 与 Anthropic 的日期格式尤其要确认）。

## 4. 子任务 B —— `lib/digest.js` 与 `lib/render.js`

对照 `daily_ai_digest.py`。**不要移植** `setup_logging` / `load_config` / `send_email` / `load_state` / `save_state` / `main()` —— 那些由插件的其它模块负责。

### 4.1 `lib/digest.js` 导出面

```js
export const CST                    // 固定 +08:00 的分钟偏移，或等价的时区工具
export const TOPIC_LABELS           // model/research/product/opensource/industry/policy/other → 中文名
export const SIGNAL_WORDS           // RegExp，逐字照抄
export function norm_title(t) -> string
export function entities(t) -> Set<string>
export function sim(a, b) -> number
export function h(s) -> string                       // sha1，前 20 位十六进制
export function dedup_and_cluster(items) -> void     // 原地写 cluster_id / cluster_sources / cluster_urls / cluster_best
export function best_url(it) -> string
export function other_urls(it, k = 2) -> string[]
export function merge_by_event(items, log) -> number // 返回归并组数
export function programmatic_score(it, window_hours) -> number
export function credibility(it, topic_hint = '') -> [string, string]   // [徽章, 说明]
export function final_score(it) -> number
export function story_key(it) -> string
export function select_top(items, n = 3) -> Item[]
export function select_progressive(items, n, windows, { min_imp = 6.0 } = {}) -> [Item[], number]
export function char_budget(imp, nov) -> number
export function actual_len(it) -> number
export function split_budget(budget) -> [number, number, number]
export function trim_to_budget(it, { tolerance = 1.15 } = {}) -> boolean
export async function llm_chat(cfg, messages, { json_mode = false, max_tokens = 4000, temperature = 0.3, timeoutMs = 180000 } = {}) -> string
export async function llm_rank(cfg, items, today, log) -> void
export async function llm_interpret(cfg, picked, log, { max_retry = 2 } = {}) -> void
```

**必须保住的行为（这些每一条都是踩过坑修出来的，别简化）：**

- `norm_title`：先剥「博客模板前缀」（`quoting` / `quotes` / `linking to` / `links` / `notes` / `re` 后跟冒号或破折号）再剥标点。这条正则让 `Quoting The New York Times` 与 `Quoting Matthew Green` 的相似度从 0.638 掉到 0.296，止住了一次错误聚类。
- `entities`：拉丁词元（去 `_STOP`）+ 中文二元组（去 `_CJK_STOP`，词表逐字照抄）。开头同样要剥 `_LINK_PREFIX_RE`。
- `dedup_and_cluster`：用 **IDF 思路**筛共享实体 —— 先统计 `df`（实体出现在多少条标题里），`rare_cap = max(2, len(prepared) // 20)`，只保留 `df <= rare_cap` 的共享实体；判据是 `r >= 0.62 || (shared.length >= 2 && r >= 0.35)`。**删掉了单实体规则**（原版那条规则会错合）。注释里写上理由：「宁可漏合，不可错合 —— 错合会虚增可信度；语义层面的同一件事交给排序 LLM 的 event 归并」。
- `cluster_sources` 存 `名(T层)` 显示串；`members` 按 `tier` 升序排；`urls = 去重后的成员 URL`（主链接是层级最高那个）；`cluster_best = members[0].source_name`。
- `merge_by_event`：按 `extra.event` 分组，**只在 `2 <= 组内条数 <= 4` 且 `组内不同 event 键 >= 2` 时归并**（超过 4 条多为模型偷懒给了通用标识，宁可不动）；归并后置每个成员的 `extra.event_merged = true`，`cluster_best = 组内 tier 最小者的 source_name`，并 `log` 一行 `语义归并：<event> ← <信源列表>`。
- `programmatic_score` = `0.35*tier_w + 0.25*min(信源数/3, 1) + 0.20*时效衰减 + 0.20*影响信号词命中 - 无摘要惩罚`；`tier_w` 是 `{1: 1.0, 2: 0.7, 3: 0.4}`；摘要短于 40 字扣 0.15。
- `credibility(it)`：徽章**由程序算，绝不交给 LLM**。三档（多信源交叉 / 单一权威信源 / 社区线索）+ 文案；`extra.event_merged` 为真时追加「（含语义归并，非标题字面匹配）」；措辞用「经 N 个信源报道」，**不要**写「独立信源」（过度断言）。
- `final_score` = `0.70 * (0.55*imp + 0.45*nov)/10 + 0.30 * programmatic_score`；`llm_topic === ''` 时退回 `programmatic_score`。
- `select_top`：**五级逐级放宽**，`ok(it, { src, top, story, lone_t3 })` 内部判定；放宽序列照抄 Python。T3 社区信源在前三级必须**有第二个独立信源**才允许入选，第 4、5 级解除。
- `select_progressive`：逐窗口筛 `published` 在窗内的条目，再筛 `llm_importance >= min_imp`；够 `n` 条就返回 `[select_top(strong, n), 该窗口]`；到最宽窗口仍不够就先用达标条目尽量凑、再用窗口内其余条目补齐。
- `char_budget`：`base = 0.55*imp + 0.45*nov`；`>=8.5→400`、`>=7.5→350`、`>=6.5→290`、`>=5.5→230`、`>=4.5→175`、否则 `120`；`nov >= 9.0` 再 `+40`；最后 clamp 到 `[120, 400]`。
- `split_budget`：`fact = max(30, round(b*0.22))`、`why = max(50, round(b*0.50))`、`impact = max(30, round(b*0.28))`。
- `llm_rank`：system/user prompt **逐字照抄**（`RANK_SYSTEM`、`RANK_USER_TMPL`，含四条严格扣分项与 event 归并要求）。解析每条返回的 `importance`/`novelty`/`topic`/`reason`/`event`；`event` 要 `.toLowerCase()` 后只留 `[a-z0-9-]`，截断 60 字符；失败条目保持哨兵值（imp=0）并计入遗漏数，日志打「LLM 排序 N 条，遗漏 M 条」「归并为 K 组事件」。
- `llm_interpret`：**三层字数控制**，一层都不能少 ——
  1. per-field 子预算写进材料块（`_build_block` 的文案逐字照抄，含「这是硬上限，超出即为不合格」）；
  2. 超标按「只列超标字段 + 其余字段保持不变，不要一起改短」做**外科手术式**重写，最多 `max_retry` 轮；判据只看**总字数**：`actual_len > budget*1.10 || actual_len < 0.78*budget`；
  3. 重写后仍超标就 `trim_to_budget` 按**句子边界**（`。！？；!?;`）从 `why → fact → impact` 整句删除，绝不截断句中，并打 warning 日志。
- `_apply_rows`：重写轮先清空整条再填（避免新旧混排）；用 `_strip_label` 剥掉模型误写进字段值的段标题（`📌 事实：` 之类，循环 sub 防死循环）；`headline` 去空白、截 30 字，空则退回 `title.slice(0, 24)`；`doubt` 非空才覆盖；兜底 `fact` 缺失填「（解读生成失败）」、`doubt` 缺失填「暂无明显疑点」。
- `llm_chat`：POST `<base_url>/chat/completions`，Bearer 鉴权；失败重试 3 次，间隔 3s / 6s；`json_mode` 时带 `response_format`；`_extract_json` 要能剥 ```json 围栏并正则兜底取第一个 `{...}`。

### 4.2 `lib/render.js` 导出面

```js
export function fmt_time(it) -> string
export function render_text(picked, meta) -> string
export function render_html(picked, meta) -> string
```

`render_text` / `render_html` / `_CARD` 模板**逐字照抄**，包括全部内联样式、颜色、字号、emoji、`[回溯]` 标记、`原文标题：` 小字、`※ {window_note}` 提示行、底部「筛选逻辑」段。

链接渲染必须用 `best_url(it)` 与 `other_urls(it)`；来源显示用
`owner = it.cluster_best || it.source_name`，当 `owner !== it.source_name` 时显示
`owner + '（线索来自 ' + it.source_name + '）'`。交叉报道的标签是「🔗 其他来源 / ↳ 其他来源」——
不是「交叉报道」，因为 HN 条目常常直接指向厂商自己的博客，那不是独立报道。

`meta` 的键由调用方（`lib/pipeline.js`）提供，先按 Python `main()` 里构造 `meta` 的地方对齐；缺失键时不要崩，按空值渲染。

## 5. 交付前自检

- `node --check lib/<file>.js` 通过。
- 每个 `SOURCES` 条目都能真实抓到条目（**贴出实际条数与一条样例标题+日期**）。
- `node -e "import('./lib/digest.js').then(m => console.log(typeof m.llm_rank))"` 之类的导入自检通过。
- 不许留 `TODO` / 占位实现 / 假数据。

## 6. 与 Python 参考实现的有意分歧

移植的原则是**行为对齐**，不是逐字对齐。下面几处是明知不同、且故意不同的；改动任何一条都要在这里记一笔。

| 处 | Python 参考 | 本实现 | 为什么 |
|---|---|---|---|
| `render_html` 转义 | **不转义**，标题/摘要直接拼进 HTML | `_esc()` 转义全部用户可控文本与属性值 | 参考实现是潜在缺陷而非设计。标题里的 `&`、`<` 会破坏卡片，恶意标题会直接注入邮件 HTML。这是唯一的**安全相关**分歧 |
| `fmt_time` 格式 | `strftime("%m-%d %H:%M")` → `10-13 09:10` | `Intl.formatToParts` 手工拼装 + `hourCycle: 'h23'` | `Intl` 会按 locale 给 `10/13, 09:10`；用 locale 模板就再也拼不出参考实现的形状。`h23` 是必须的，某些 ICU 版本下 `hour12:false` 会把午夜渲染成 `24:00` |
| `email.to` 为空 | 无此概念 | `DEFAULTS.email.to = []` 视为「未设置」，继续回退到密钥文件的 `recipients` | 空数组若按「显式设过」处理，密钥文件里的收件人会被静默吞掉，症状是「配置看起来齐全但 `validate()` 说没配收件人」 |
| `--if-due` 时刻守卫 | 无 | 早于 `schedule.time` 一律不发 | 登录/解锁触发器不受时刻限制。没有这道守卫，凌晨开机就会发出一份只采到零星条目、必然走 72h 回溯的日报 |
| `href` 为空 | 无处理 | 无链接时渲染纯文本标签 | 空 `href=""` 在邮件客户端里是个死链接 |

`state.json` 与 Python 的 `seen.json` 结构不同（本实现另有 `runs` / `last_error` 等字段）。
需要接管旧文件时**显式**调用 `migrateLegacyState()`，`loadState()` 不会自动迁移——隐式迁移会让一次读错变成一次静默重发。

