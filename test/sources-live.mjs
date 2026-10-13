/**
 * Throwaway smoke test for lib/sources.js — runs every SOURCES entry against the
 * real network and prints per-source entry counts plus one sample title/date.
 *
 * stdout on Windows defaults to the console codepage, which mangles Chinese, so
 * everything is written as explicit UTF-8 to a file instead.
 *
 *   node tmp/smoke-sources.mjs
 */

import { writeFileSync } from 'node:fs';
import {
  SOURCES, fetch_rss, fetch_arxiv, fetch_anthropic, fetch_hn,
  clean_text, canonical_url, parse_date,
} from '../lib/sources.js';

const FETCHERS = {
  rss: fetch_rss,
  arxiv: fetch_arxiv,
  anthropic: fetch_anthropic,
  hn: fetch_hn,
};

const lines = [];
const say = (s) => {
  lines.push(s);
  console.log(s.replace(/[^\x20-\x7e]/g, '?'));
};

/** HH:MM:SS for a Date, in UTC. */
const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : 'null');

// ---------------------------------------------------------------- parsing parity

say('== parsing parity ==');
const CLEAN_CASES = [
  ['<p>Hello&nbsp;<b>world</b> &amp; more</p>', 900],
  ['  a\n\n  b\t c  ', 900],
  ['&#39;quoted&#39; and &#x27;again&#x27;', 900],
  ['中文测试，标点。', 900],
  ['<script>evil()</script>visible', 900],
  ['abcdef', 3],
];
for (const [s, lim] of CLEAN_CASES) say(`clean_text(${JSON.stringify(s)}, ${lim}) = ${JSON.stringify(clean_text(s, lim))}`);

const URL_CASES = [
  'https://example.com/a?utm_source=x&utm_medium=y&id=7',
  'https://example.com/a?ref=feed#frag',
  'http://example.com/a/?utm_campaign=z',
  'https://example.com/a',
];
for (const u of URL_CASES) say(`canonical_url(${u}) = ${canonical_url(u)}`);

const DATE_CASES = [
  'Mon, 13 Oct 2026 09:47:05 +0800',
  'Mon, 13 Oct 2026 09:47:05 GMT',
  'Mon, 13 Oct 2026 09:47:05 +08',
  'Mon, 13 Oct 26 09:47:05 +0800',
  '2026-10-13T09:47:05Z',
  '2026-10-13T09:47:05+08:00',
  '2026-10-13T09:47:05.123456+00:00',
  '2026-10-13T09:47:05',
  '2026-10-13 09:47:05Z',
  '2026-10-13',
  'October 13, 2026',
  'Tue, 13 Oct 2026 25:00:00 +0000',
  'not a date',
];
for (const d of DATE_CASES) say(`parse_date(${JSON.stringify(d)}) = ${iso(parse_date(d))}`);

// ---------------------------------------------------------------- live sources

say('');
say('== live sources ==');
say('name                 count  sample title                                   sample published (ISO)');
say('-'.repeat(110));

let failures = 0;
for (const src of SOURCES) {
  try {
    const items = await FETCHERS[src.kind](src, { max_items: src.max });
    const first = items[0];
    const title = first ? first.title : '(none)';
    const pub = first ? iso(first.published) : '(none)';
    const clipped = [...title].slice(0, 40).join('').padEnd(40);
    say(`${src.name.padEnd(20)} ${String(items.length).padStart(5)}  ${clipped}  ${pub}`);
    if (first) {
      say(`      key=${first.source_key} tier=${first.tier} url=${first.url}`);
      say(`      summary=${JSON.stringify([...first.summary].slice(0, 70).join(''))}`);
    }
  } catch (e) {
    failures += 1;
    say(`${src.name.padEnd(20)}   ERR  ${e.name}: ${String(e.message).slice(0, 90)}`);
  }
}

say('');
say(`sources attempted=${SOURCES.length} failed=${failures}`);

// Tee to a file as well as stdout: this run is the evidence for the claim that
// all ten sources work, and it is much easier to paste than scrollback.
writeFileSync(new URL('./sources-live.out.txt', import.meta.url), `${lines.join('\n')}\n`, 'utf8');

process.exit(failures === 0 ? 0 : 1);
