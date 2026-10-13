/**
 * Throwaway feed-parser robustness suite. `fetch_rss` is exercised end-to-end with the
 * network stubbed out, so every case is deterministic: RSS 2.0, RSS 1.0/RDF, Atom,
 * namespaces, CDATA, entity decoding, multiple self-closing <link> elements, malformed
 * markup, and a pathological input for regex backtracking.
 *
 *   node tmp/feed-cases.mjs
 */

import { performance } from 'node:perf_hooks';
import { fetch_rss } from '../lib/sources.js';

const SRC = {
  key: 'test', name: 'Test源', tier: 2, kind: 'rss', url: 'https://example.test/feed',
};

/** Serve one canned body through the real fetch path. */
function stub(body, status = 200) {
  globalThis.fetch = async () => new Response(body, {
    status,
    headers: { 'Content-Type': 'application/xml' },
  });
}

const cases = [];
const one = (name, body, expect, opts = {}) => cases.push({ name, body, expect, opts });

// ---- RSS 2.0, the ordinary shape
one('rss2-basic', `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Feed</title>
  <item>
    <title>First post</title>
    <link>https://example.com/1?utm_source=rss</link>
    <description>Summary one</description>
    <pubDate>Mon, 13 Oct 2026 09:47:05 +0800</pubDate>
  </item>
  <item>
    <title>Second post</title>
    <link>https://example.com/2</link>
    <description>Summary two</description>
    <pubDate>Tue, 14 Oct 2026 00:00:00 GMT</pubDate>
  </item>
</channel></rss>`, { count: 2, title0: 'First post', url0: 'https://example.com/1', pub0: '2026-10-13T01:47:05.000Z', summary0: 'Summary one' });

// ---- CDATA + entities inside CDATA
one('rss2-cdata', `<rss version="2.0"><channel><item>
  <title><![CDATA[中文标题 & 保留实体<br>]]></title>
  <link><![CDATA[https://example.com/cdata]]></link>
  <description><![CDATA[<p>Body with <b>markup</b> &amp; an entity</p>]]></description>
</item></channel></rss>`, { count: 1, title0: '中文标题 & 保留实体', url0: 'https://example.com/cdata', summary0: 'Body with markup & an entity' });

// ---- escaped HTML inside a normal element
one('rss2-escaped-html', `<rss version="2.0"><channel><item>
  <title>Escaped &amp; encoded &#x27;title&#x27;</title>
  <link>https://example.com/esc</link>
  <description>&lt;p&gt;Hello&nbsp;&lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</description>
</item></channel></rss>`, { count: 1, title0: "Escaped & encoded 'title'", summary0: 'Hello world' });

// ---- namespaced tags: dc:date, content:encoded, atom:link
one('rss2-namespaced', `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
  <atom:link href="https://example.com/feed" rel="self" type="application/rss+xml"/>
  <item>
    <title>Namespaced</title>
    <link>https://example.com/ns</link>
    <dc:date>2026-10-13T09:47:05Z</dc:date>
    <content:encoded><![CDATA[<p>Rich content here</p>]]></content:encoded>
  </item>
</channel></rss>`, { count: 1, title0: 'Namespaced', pub0: '2026-10-13T09:47:05.000Z', summary0: 'Rich content here' });

// ---- RSS 1.0 / RDF
one('rss1-rdf', `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com/"><title>RDF feed</title></channel>
  <item rdf:about="https://example.com/rdf1">
    <title>RDF item one</title>
    <link>https://example.com/rdf1</link>
    <description>RDF summary</description>
    <dc:date>2026-10-13T09:47:05+00:00</dc:date>
  </item>
</rdf:RDF>`, { count: 1, title0: 'RDF item one', url0: 'https://example.com/rdf1', pub0: '2026-10-13T09:47:05.000Z' });

// ---- Atom: multiple self-closing <link>s, rel must pick alternate
one('atom-links', `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom feed</title>
  <link rel="self" href="https://example.com/atom.xml"/>
  <link rel="hub" href="https://example.com/hub"/>
  <entry>
    <title>Atom entry</title>
    <link rel="self" href="https://example.com/self"/>
    <link rel="alternate" type="text/html" href="https://www.example.com/article?utm_medium=feed"/>
    <link rel="replies" href="https://example.com/replies"/>
    <updated>2026-10-13T09:47:05Z</updated>
    <summary>Atom summary text</summary>
  </entry>
</feed>`, { count: 1, title0: 'Atom entry', url0: 'https://www.example.com/article', pub0: '2026-10-13T09:47:05.000Z', summary0: 'Atom summary text' });

// ---- Atom with NO rel attribute (must take the first link)
one('atom-no-rel', `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <title>No rel</title>
  <link href="https://example.com/norel"/>
  <updated>2026-10-13T09:47:05Z</updated>
</entry></feed>`, { count: 1, url0: 'https://example.com/norel' });

// ---- Atom with only a self link (nothing better available)
one('atom-only-self', `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <title>Only self</title>
  <link rel="self" href="https://example.com/onlyself"/>
  <updated>2026-10-13T09:47:05Z</updated>
</entry></feed>`, { count: 1, url0: 'https://example.com/onlyself' });

// ---- guid fallback when there is no <link> at all
one('guid-fallback', `<rss version="2.0"><channel><item>
  <title>Guid only</title>
  <guid isPermaLink="false">https://example.com/guid-only</guid>
  <pubDate>Mon, 13 Oct 2026 09:47:05 +0000</pubDate>
</item></channel></rss>`, { count: 1, url0: 'https://example.com/guid-only' });

// ---- entries missing title or link are dropped
one('drops-incomplete', `<rss version="2.0"><channel>
  <item><title>No link here</title><description>x</description></item>
  <item><link>https://example.com/no-title</link><description>x</description></item>
  <item><title>Complete</title><link>https://example.com/complete</link></item>
</channel></rss>`, { count: 1, title0: 'Complete' });

// ---- comments must not be mistaken for items
one('comments-ignored', `<rss version="2.0"><channel>
  <!-- <item><title>Commented out</title><link>https://example.com/nope</link></item> -->
  <item><title>Real one</title><link>https://example.com/real</link></item>
</channel></rss>`, { count: 1, title0: 'Real one' });

// ---- an item with no description at all (the common shape in minimal feeds)
one('no-description', `<rss version="2.0"><channel>
  <item><title>Bare</title><link>https://example.com/bare</link></item>
  <item><title>Also bare</title><link>https://example.com/bare2</link></item>
</channel></rss>`, { count: 2, title0: 'Bare', summary0: '', title1: 'Also bare' });

// ---- empty elements: <title></title> and <link></link> must not resurrect as text
one('empty-elements', `<rss version="2.0"><channel>
  <item><title>Ok</title><link>https://example.com/ok</link><description></description></item>
</channel></rss>`, { count: 1, title0: 'Ok', summary0: '' });

// ---- attribute quoting variants
one('attr-quotes', `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <title>Attrs</title>
  <link rel='alternate' href='https://example.com/single'/>
  <updated>2026-10-13T09:47:05Z</updated>
</entry></feed>`, { count: 1, url0: 'https://example.com/single' });

// ---- max_items truncation
one('max-items', (() => {
  const items = Array.from({ length: 10 }, (_, i) => `<item><title>T${i}</title><link>https://example.com/${i}</link></item>`).join('');
  return `<rss version="2.0"><channel>${items}</channel></rss>`;
})(), { count: 3, title0: 'T0' }, { max_items: 3 });

// ---- empty feed
one('empty-feed', '<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>', { count: 0 });

// ---- whitespace title must not count as a title
one('whitespace-title', `<rss version="2.0"><channel><item>
  <title>   </title><link>https://example.com/ws</link>
</item></channel></rss>`, { count: 0 });

// ---- pathological input: must not backtrack catastrophically
one('backtracking', `<rss version="2.0"><channel><item>
  <title>${'a'.repeat(60000)}</title>
  <link>https://example.com/big</link>
  <description>${'<p>'.repeat(4000)}${'x'.repeat(20000)}</description>
</item></channel></rss>`, { count: 1 }, { maxMs: 4000 });

// ---- real-world RDF/Atom mix: two entries, one without a date
one('mixed-dates', `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Dated</title><link href="https://example.com/d"/><updated>2026-10-13T09:47:05Z</updated></entry>
  <entry><title>Undated</title><link href="https://example.com/u"/><updated>bogus</updated></entry>
</feed>`, { count: 2, title1: 'Undated', pub1: null });

let pass = 0;
let fail = 0;
const report = [];

for (const c of cases) {
  stub(c.body);
  const started = performance.now();
  let items;
  let err = null;
  try {
    // eslint-disable-next-line no-await-in-loop
    items = await fetch_rss(SRC, c.opts);
  } catch (e) {
    err = e;
  }
  const ms = performance.now() - started;
  const problems = [];

  if (err) problems.push(`threw ${err.name}: ${err.message}`);
  else {
    const e = c.expect;
    if (e.count !== undefined && items.length !== e.count) problems.push(`count=${items.length} want ${e.count}`);
    const check = (idx, field, want) => {
      if (want === undefined) return;
      const got = items[idx] ? items[idx][field] : '<no item>';
      const g = got instanceof Date ? got.toISOString() : got;
      if (g !== want) problems.push(`${field}[${idx}]=${JSON.stringify(g)} want ${JSON.stringify(want)}`);
    };
    check(0, 'title', e.title0);
    check(0, 'url', e.url0);
    check(0, 'published', e.pub0);
    check(0, 'summary', e.summary0);
    check(1, 'title', e.title1);
    check(1, 'published', e.pub1);
  }
  if (c.opts.maxMs && ms > c.opts.maxMs) problems.push(`took ${ms.toFixed(0)}ms > ${c.opts.maxMs}ms`);

  if (problems.length) {
    fail += 1;
    report.push(`FAIL ${c.name}\n     ${problems.join('\n     ')}`);
  } else {
    pass += 1;
    const first = items && items[0];
    report.push(`ok   ${c.name.padEnd(20)} n=${items ? items.length : '-'} ${first ? JSON.stringify(first.title).slice(0, 34) : ''} ${ms.toFixed(1)}ms`);
  }
}

process.stdout.write(`${report.join('\n')}\n\nfeed cases: ${pass} passed, ${fail} failed\n`);
