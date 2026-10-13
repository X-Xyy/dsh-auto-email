/**
 * dsh-auto-email — the row record every stage of the pipeline passes around.
 *
 * This mirrors the `Item` dataclass of the reference Python implementation
 * (`ai-daily-digest/sources.py:115`) attribute for attribute, so a reader who
 * knows one knows the other. The names stay snake_case on purpose: this port is
 * meant to be diffable against its source of truth, not idiomatic for its own sake.
 */

/**
 * Build one pipeline row, filling every field so no downstream stage has to guard
 * against `undefined`.
 *
 * @param {object} [init] - partial item; unknown keys are ignored. `source` is
 *   accepted as a synonym for `source_key`, because both spellings appear in the
 *   reference implementation.
 * @returns {object} a complete item record.
 */
export function createItem(init = {}) {
  const item = {
    /** Source key from `SOURCES`, e.g. `qbitai`. */
    source_key: String(init.source_key ?? init.source ?? ''),
    /** Human-readable source name, e.g. `量子位`. */
    source_name: String(init.source_name ?? ''),
    /** 1 = first-party official, 2 = authoritative media, 3 = community. */
    tier: Number.isFinite(init.tier) ? init.tier : 3,
    /** Headline as published. */
    title: String(init.title ?? ''),
    /** Canonical article URL. */
    url: String(init.url ?? ''),
    /** Plain-text summary, tags stripped, whitespace collapsed. */
    summary: String(init.summary ?? ''),
    /** Publication instant, or `null` when the feed gave nothing parseable. */
    published: init.published instanceof Date && !Number.isNaN(init.published.getTime()) ? init.published : null,
    /**
     * Free-form bag. Known keys:
     * `category` (source-provided section), `event` (LLM event slug),
     * `headline` (LLM Chinese title), `budget` (LLM char budget),
     * `aged` (came from a fallback window), `event_merged` (credibility was
     * topped up by semantic, not literal, matching).
     */
    extra: init.extra === undefined || init.extra === null ? {} : { ...init.extra },

    // ---- filled in by later stages
    /** Cluster id assigned by `dedup_and_cluster`; `-1` until then. */
    cluster_id: Number.isInteger(init.cluster_id) ? init.cluster_id : -1,
    /** `["量子位(T2)", "TechCrunch AI(T2)"]` — display strings, tier included. */
    cluster_sources: Array.isArray(init.cluster_sources) ? [...init.cluster_sources] : [],
    /** Every distinct member URL, best (highest-tier) first. */
    cluster_urls: Array.isArray(init.cluster_urls) ? [...init.cluster_urls] : [],
    /** Source name of the highest-tier member; the article's real owner. */
    cluster_best: String(init.cluster_best ?? ''),
    /** Programmatic score, set by the pipeline before LLM ranking. */
    prog_score: Number.isFinite(init.prog_score) ? init.prog_score : 0,
    /** LLM importance 0-10; `0` means "not ranked yet". */
    llm_importance: Number.isFinite(init.llm_importance) ? init.llm_importance : 0,
    /** LLM technical novelty 0-10; `0` means "not ranked yet". */
    llm_novelty: Number.isFinite(init.llm_novelty) ? init.llm_novelty : 0,
    /** LLM topic cluster key; `''` means "not ranked yet". */
    llm_topic: String(init.llm_topic ?? ''),
    /** One-sentence LLM justification, kept for the log and the archive. */
    llm_reason: String(init.llm_reason ?? ''),
  }

  // `source` and `source_key` are the same field under two names — the Python
  // `fetch_*` functions write `source_key`, while older call sites say `source`.
  // One storage slot behind an accessor keeps them from drifting apart.
  Object.defineProperty(item, 'source', {
    get() { return this.source_key },
    set(value) { this.source_key = String(value ?? '') },
    enumerable: false,
    configurable: true,
  })

  // Same reasoning for the age helper: the Python code calls `it.age_hours()`,
  // so the method exists as well as the free `ageHours` function.
  Object.defineProperty(item, 'age_hours', {
    value: function ageHoursMethod(now = new Date()) { return ageHours(this, now) },
    enumerable: false,
    writable: true,
    configurable: true,
  })

  return item
}

/**
 * Hours since publication, in UTC. Mirrors Python's `Item.age_hours()`: an item
 * with no date is treated as very old (999) rather than as brand new, so it can
 * never win a recency comparison by accident.
 *
 * @param {object} item - the row.
 * @param {Date} [now] - comparison instant; defaults to now.
 * @returns {number} non-negative hours, or 999 when undated.
 */
export function ageHours(item, now = new Date()) {
  if (!(item?.published instanceof Date)) return 999
  return Math.max(0, (now.getTime() - item.published.getTime()) / 3_600_000)
}
