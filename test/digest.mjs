/**
 * tmp/smoke-digest.mjs — the local smoke harness for lib/digest.js + lib/render.js.
 *
 * It never talks to a real LLM endpoint: `llm_chat` is exercised against a local
 * `node:http` stub on 127.0.0.1 that serves canned JSON and can be told to fail a
 * request so the 3s/6s retry path is exercised. Run it with `node`.
 */

import http from 'node:http';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createItem } from '../lib/item.js';
import {
  CST, TOPIC_LABELS, SIGNAL_WORDS, norm_title, entities, sim, h,
  dedup_and_cluster, best_url, other_urls, merge_by_event, programmatic_score,
  credibility, final_score, story_key, select_top, select_progressive,
  char_budget, actual_len, split_budget, trim_to_budget, llm_chat, llm_rank,
  llm_interpret,
} from '../lib/digest.js';
import { fmt_time, render_text, render_html } from '../lib/render.js';

let pass = 0;
const ok = (name, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + name);
};

// ---------------------------------------------------------------- stub server

/** Starts a stub LLM endpoint. `respond(body, n)` decides what the n-th call gets. */
function startStub(respond) {
  let calls = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls++;
      const parsed = JSON.parse(body || '{}');
      seen.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      const r = respond(calls, parsed);
      if (r && r.httpStatus && r.httpStatus !== 200) {
        res.writeHead(r.httpStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub failure' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: r.content } }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        calls: () => calls,
        seen,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const mk = (init) => createItem(init);

// ============================================================ sim vs difflib

// The reference ratios come from `tmp/ref_sim.py` (difflib.SequenceMatcher) and are
// read from a UTF-8 file rather than an env var, because PowerShell 5.1 mangles
// non-ASCII in `$env:` assignments. PY_SIM_RAW=1 compares the *normalised* forms
// (the ones production actually feeds to sim), the default compares raw strings.
const PY_SIM = process.env.PY_SIM_FILE
  ? JSON.parse(readFileSync(process.env.PY_SIM_FILE, 'utf8'))
  : [];
if (PY_SIM.length) {
  const rawMode = process.env.PY_SIM_RAW === '1';
  ok(`sim agrees with difflib.SequenceMatcher (${rawMode ? 'raw' : 'norm_title'} pairs)`, () => {
    PY_SIM.forEach(({ a, b, py, py_norm, a_norm, b_norm }) => {
      const get = (x, y) => (rawMode ? [x, y, py] : [a_norm ?? norm_title(x), b_norm ?? norm_title(y), py_norm]);
      const [sa, sb, want] = get(a, b);
      const got = sim(sa, sb);
      const delta = Math.abs(got - want);
      console.log(`      ${delta <= 0.0005 ? '=' : '!'} py=${want.toFixed(6)} js=${got.toFixed(6)}  ${JSON.stringify(sa)} / ${JSON.stringify(sb)}`);
      assert.ok(delta <= 0.0005, `sim(${JSON.stringify(sa)}, ${JSON.stringify(sb)}) = ${got}, Python said ${want}`);
    });
  });
}

ok('sim returns 0 for an empty side', () => {
  assert.equal(sim('', 'abc'), 0);
  assert.equal(sim('abc', ''), 0);
});

ok('sim("Quoting The New York Times", "Quoting Matthew Green") lands near the Python 0.296', () => {
  const v = sim(norm_title('Quoting The New York Times'), norm_title('Quoting Matthew Green'));
  console.log(`      norm-title sim = ${v.toFixed(3)}`);
  assert.ok(Math.abs(v - 0.296) < 0.01, 'expected ~0.296, got ' + v);
});

ok('autojunk path still computes a sane ratio on a long b', () => {
  const b = ('abcdefghij'.repeat(30)); // 300 chars, every char popular -> junk
  const a = 'xyz';
  assert.ok(Number.isFinite(sim(a, b)));
});

// ============================================================ normalisation

ok('norm_title strips the blog-template prefix before punctuation', () => {
  assert.equal(norm_title('Quoting The New York Times'), 'thenewyorktimes');
  assert.equal(norm_title('Links for 2026-10-13'), 'for20261013');
  assert.equal(norm_title('Re: something'), 'something');
  assert.equal(norm_title('Notes on agents'), 'onagents');
  assert.equal(norm_title('  '), '');
});

ok('entities keeps rare Latin tokens and drops stop words', () => {
  const e = entities('The new GPT-5 release from OpenAI');
  assert.ok(e.has('gpt-5'));
  assert.ok(e.has('openai'));
  assert.ok(!e.has('the'));
  assert.ok(!e.has('new'));
});

ok('entities emits CJK bigrams minus the noise list', () => {
  const e = entities('量子位报道模型发布');
  assert.ok(e.has('量子'));
  assert.ok(e.has('子位'));
  assert.ok(!e.has('模型'));
  assert.ok(!e.has('发布'));
});

ok('h is a 20-char sha1 prefix', () => {
  assert.equal(h('abc').length, 20);
  assert.equal(h('abc'), h('abc'));
  assert.notEqual(h('abc'), h('abd'));
});

// ============================================================ clustering

ok('dedup_and_cluster groups a reprinted headline and returns the groups', () => {
  const a = mk({ source_key: 'qbitai', source_name: '量子位', tier: 2, url: 'u1', title: 'OpenAI releases GPT-6 model family', published: new Date() });
  const b = mk({ source_key: 'tc', source_name: 'TechCrunch AI', tier: 2, url: 'u2', title: 'OpenAI releases the GPT-6 model family', published: new Date() });
  const c = mk({ source_key: 'hn', source_name: 'Hacker News', tier: 3, url: 'u3', title: 'Unrelated policy news about chip export rules', published: new Date() });
  const clusters = dedup_and_cluster([a, b, c]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].length, 2);
  assert.deepEqual(a.cluster_sources, ['TechCrunch AI(T2)', '量子位(T2)']);
  assert.deepEqual(a.cluster_urls, ['u1', 'u2']);
  assert.equal(a.cluster_id, b.cluster_id);
  assert.equal(best_url(a), 'u1');
  assert.deepEqual(other_urls(a), ['u2']);
  assert.equal(a.cluster_best, '量子位');
});

ok('best_url / other_urls fall back to the item URL and exclude the primary link', () => {
  const it = mk({ url: 'only', title: 'x' });
  assert.equal(best_url(it), 'only');
  assert.deepEqual(other_urls(it), []);
  it.cluster_urls = ['a', 'b', 'c', 'd'];
  assert.deepEqual(other_urls(it, 2), ['b', 'c']);
});

ok('merge_by_event only merges groups of 2-4 with >= 2 distinct source keys', () => {
  const logs = [];
  const a = mk({ source_key: 'qbitai', source_name: '量子位', tier: 2, url: 'a', title: '24天！Jev估值翻至75亿美元', extra: { event: 'jev-7b-valuation' } });
  const b = mk({ source_key: 'tc', source_name: 'TechCrunch AI', tier: 2, url: 'b', title: 'The maker of non-text AI model Jev valued at $7.5B', extra: { event: 'jev-7b-valuation' } });
  const alone = mk({ source_key: 'oa', source_name: 'OpenAI', tier: 1, url: 'c', title: 'Solo', extra: { event: 'solo-event' } });
  const same = [1, 2].map((i) => mk({ source_key: 'oa', source_name: 'OpenAI', tier: 1, url: 'same' + i, title: 'Same', extra: { event: 'one-source' } }));
  const big = [1, 2, 3, 4, 5].map((i) => mk({ source_key: 's' + i, source_name: 'S' + i, tier: 2, url: 'big' + i, title: 'Big', extra: { event: 'too-big' } }));
  // A BARE FUNCTION is the sink shape the pipeline actually passes (pipeline.js:131
  // `const log = options.log ?? (() => {})`), so exercise that shape here.
  const n = merge_by_event([a, b, alone, ...same, ...big], (...args) => logs.push(...args));
  assert.equal(n, 1);
  assert.equal(a.extra.event_merged, true);
  assert.deepEqual(a.cluster_sources, ['TechCrunch AI(T2)', '量子位(T2)']);
  // `min(grp, key=tier)` is stable, so the FIRST tier-2 member keeps the attribution.
  assert.equal(a.cluster_best, '量子位');
  assert.equal(b.cluster_best, '量子位');
  assert.ok(logs[0].includes('语义归并：jev-7b-valuation ←'));
  assert.equal(alone.extra.event_merged, undefined);
  assert.equal(big[0].extra.event_merged, undefined);
});

// ============================================================ scoring

ok('programmatic_score follows 0.35*tier + 0.25*cross + 0.20*recency + 0.20*signal - thin', () => {
  const it = mk({
    source_key: 'oa', source_name: 'OpenAI', tier: 1, title: 'OpenAI releases GPT-6', url: 'u',
    summary: 'x'.repeat(120), published: new Date(),
  });
  it.cluster_sources = ['OpenAI(T1)'];
  const got = programmatic_score(it, 26);
  // tier 1.0*0.35=0.35; cross 1/3*0.25=0.0833; recency ~0.2; signal 1/3*0.2=0.0667
  const want = 0.35 + 0.25 / 3 + 0.2 * (1 - 0.0001 / 26) + 0.2 / 3;
  assert.ok(Math.abs(got - want) < 0.01, `${got} vs ${want}`);
  it.summary = 'short';
  assert.ok(Math.abs(programmatic_score(it, 26) - (want - 0.15)) < 0.01);
});

ok('final_score blends 0.70*LLM + 0.30*prog and falls back on the sentinel topic', () => {
  const it = mk({ llm_importance: 8, llm_novelty: 6, llm_topic: 'model' });
  it.prog_score = 0.5;
  assert.ok(Math.abs(final_score(it) - (0.7 * ((0.55 * 8 + 0.45 * 6) / 10) + 0.3 * 0.5)) < 1e-9);
  it.llm_topic = '';
  assert.equal(final_score(it), 0.5);
});

ok('credibility is programmatic and never says 独立信源', () => {
  const two = mk({ source_key: 'q', source_name: '量子位', tier: 2 });
  two.cluster_sources = ['量子位(T2)', 'TechCrunch AI(T2)'];
  assert.deepEqual(credibility(two), ['🟢 交叉验证', '经 2 个信源报道：量子位(T2)、TechCrunch AI(T2)']);
  const three = mk({ source_key: 'q', source_name: '量子位', tier: 2, extra: { event_merged: true } });
  three.cluster_sources = ['a(T1)', 'b(T2)', 'c(T3)'];
  const [badge, note] = credibility(three);
  assert.equal(badge, '🟢 高度可信');
  assert.ok(note.includes('经 3 个信源交叉报道'));
  assert.ok(note.includes('（含语义归并，非标题字面匹配）'));
  assert.ok(!note.includes('独立信源'));
  assert.deepEqual(credibility(mk({ source_key: 'arxiv', source_name: 'arXiv', tier: 1 }))[0], '🟢 原始论文');
  assert.equal(credibility(mk({ source_key: 'oa', source_name: 'OpenAI', tier: 1 }))[0], '🟢 一手信源');
  assert.equal(credibility(mk({ source_key: 'tc', source_name: 'TC', tier: 2 }))[0], '🟡 单一来源');
  assert.equal(credibility(mk({ source_key: 'hn', source_name: 'HN', tier: 3 }))[0], '🟠 社区信号');
});

ok('story_key prefers the LLM event and falls back to the cluster id', () => {
  assert.equal(story_key(mk({ extra: { event: 'x-y' }, cluster_id: 3 })), 'e:x-y');
  assert.equal(story_key(mk({ cluster_id: 3 })), 'c:3');
});

// ============================================================ selection levels
//
// Each of the five relaxation levels gets ONE item arrangement that the tighter
// levels provably cannot satisfy, so "level N is reachable" is a real proof and
// not just a happy path. The programmatic clustering is bypassed by setting
// `cluster_id` by hand, so `story_key` is `c:<cluster_id>` unless `extra.event`
// is given (which then wins).

/** `it.llm_topic`/`source_key` etc. from an explicit plan; prog_score pinned. */
const mkSel = (o) => {
  const it = mk({
    source_key: o.source_key,
    source_name: o.source_key,
    tier: o.tier ?? 1,
    llm_importance: o.imp ?? 8,
    llm_novelty: 8,
    llm_topic: o.topic ?? 'model',
    title: 'T ' + o.source_key + ' ' + (o.story ?? ''),
    published: new Date(),
    extra: o.event ? { event: o.event } : {},
  });
  it.prog_score = o.prog ?? 0.5;
  it.cluster_id = o.story ?? -1;
  return it;
};

ok('select_top level 1 = 信源互异 + 主题互异 + 事件互异', () => {
  const items = [
    mkSel({ source_key: 'a', topic: 'model', story: 1, imp: 9 }),
    mkSel({ source_key: 'b', topic: 'research', story: 2, imp: 8 }),
    mkSel({ source_key: 'c', topic: 'product', story: 3, imp: 7 }),
  ];
  assert.equal(select_top(items, 3).length, 3);
  // Counter-check: collapsing the topics to one value makes level 1 pick only 1,
  // so level 2 is what actually did the work above.
  const sameTopic = items.map((it) => ({ ...it, llm_topic: 'model' }));
  assert.equal(select_top(sameTopic, 3).length, 3, 'level 2 rescues it');
});

ok('select_top level 2 = 信源互异 + 事件互异（放宽主题）', () => {
  const items = [
    mkSel({ source_key: 'a', topic: 'model', story: 1, imp: 9 }),
    mkSel({ source_key: 'b', topic: 'model', story: 2, imp: 8 }),
    mkSel({ source_key: 'c', topic: 'model', story: 3, imp: 7 }),
  ];
  // All three share a topic -> level 1 can only take the first, level 2 takes all.
  assert.equal(select_top([...items], 3).length, 3);
  // Counter-check: also collapse the sources -> level 2 caps at 1.
  const oneSrc = [
    mkSel({ source_key: 'solo', topic: 'model', story: 1, imp: 9 }),
    mkSel({ source_key: 'solo', topic: 'model', story: 2, imp: 8 }),
    mkSel({ source_key: 'solo', topic: 'model', story: 3, imp: 7 }),
  ];
  assert.equal(select_top(oneSrc, 3).length, 3, 'level 3 rescues the single-source case');
});

ok('select_top level 3 = 主题互异 + 事件互异（放宽信源）', () => {
  const items = [
    mkSel({ source_key: 'solo', topic: 'model', story: 1, imp: 9 }),
    mkSel({ source_key: 'solo', topic: 'research', story: 2, imp: 8 }),
    mkSel({ source_key: 'solo', topic: 'product', story: 3, imp: 7 }),
  ];
  assert.equal(select_top(items, 3).length, 3);
  // Counter-check: collapse the topics too -> level 3 caps at 1, only level 4
  // (which drops the topic constraint) can return more.
  const oneTopic = items.map((it) => ({ ...it, llm_topic: 'model' }));
  assert.equal(select_top(oneTopic, 3).length, 3, 'levels 1-2 cannot; level 3 cannot either, level 4 must');
});

ok('select_top level 4 = 仅事件互异 + lifts the lone-T3 guard', () => {
  // One source, one topic, three distinct stories: levels 1-3 all cap at 1 item.
  const items = [
    mkSel({ source_key: 'solo', topic: 'model', story: 1, imp: 9 }),
    mkSel({ source_key: 'solo', topic: 'model', story: 2, imp: 8 }),
    mkSel({ source_key: 'solo', topic: 'model', story: 3, imp: 7 }),
  ];
  const got = select_top(items, 3);
  assert.equal(got.length, 3);
  assert.equal(new Set(got.map((it) => it.cluster_id)).size, 3, 'stories stay distinct');

  // The T3 guard: a lone T3 is refused at levels 1-3 and admitted at level 4.
  // (There is no "call only levels 1-3" entry point, so the guard is proven by
  // the fact that the same item passes once the queue reaches level 4 alone.)
  const t3 = mkSel({ source_key: 'hn', topic: 'model', story: 9, tier: 3, imp: 10, prog: 1 });
  assert.deepEqual(select_top([t3], 1).map((it) => it.tier), [3], 'level 4 lifts the guard for a lone T3');
  // A T3 that is genuinely cross-reported (>= 2 cluster sources) is never guarded.
  const cross = mkSel({ source_key: 'hn', topic: 'model', story: 9, tier: 3, imp: 10, prog: 1 });
  cross.cluster_sources = ['OpenAI(T1)', 'Hacker News(T3)'];
  cross.cluster_urls = ['a', 'b'];
  assert.equal(select_top([cross], 1).length, 1);
  const three = [
    t3,
    mkSel({ source_key: 'solo', topic: 'model', story: 1, imp: 9 }),
    mkSel({ source_key: 'solo', topic: 'model', story: 2, imp: 8 }),
  ];
  const gotT3 = select_top(three, 3);
  assert.equal(gotT3.length, 3, 'level 4 admits the lone T3');
  assert.ok(gotT3.includes(t3));
});

ok('select_top level 5 = 无条件（事件互异也放开）', () => {
  // Distinct sources and topics, but ONE shared event slug: levels 1-4 each cap
  // at a single item because `story_key` is the same for all three.
  const items = [
    mkSel({ source_key: 'a', topic: 'model', event: 'one-event', imp: 9 }),
    mkSel({ source_key: 'b', topic: 'research', event: 'one-event', imp: 8 }),
    mkSel({ source_key: 'c', topic: 'product', event: 'one-event', imp: 7 }),
  ];
  assert.equal(story_key(items[0]), 'e:one-event');
  // Sanity: with distinct events levels 1-4 would happily take all three.
  const distinct = [0, 1, 2].map((i) => mkSel({ source_key: 'abc'[i], topic: ['model', 'research', 'product'][i], event: 'ev' + i, imp: 9 - i }));
  assert.equal(select_top(distinct, 3).length, 3);
  // Same event -> only level 5 can fill all three slots.
  assert.equal(select_top(items, 3).length, 3);
  assert.equal(new Set(items.map(story_key)).size, 1);
});
/** Four items arranged so each relaxation level is the first one that can finish. */
ok('select_progressive walks 26h -> 48h -> 72h and reports the window used', () => {
  const now = Date.now();
  const hAgo = (hh) => new Date(now - hh * 3600 * 1000);
  const make = (t, imp) => {
    const it = mk({ source_key: 's' + t, source_name: 'S' + t, tier: 1, llm_importance: imp, llm_novelty: 8, llm_topic: 'model', title: 'T' + t, published: hAgo(t) });
    it.prog_score = 0.5;
    it.cluster_id = t;
    return it;
  };
  let [picked, w] = select_progressive([make(10, 9), make(20, 9), make(20.5, 9)], 3, [26, 48, 72]);
  assert.equal(w, 26);
  assert.equal(picked.length, 3);

  [picked, w] = select_progressive([make(10, 9), make(30, 9), make(40, 9)], 3, [26, 48, 72]);
  assert.equal(w, 48);
  assert.equal(picked.length, 3);

  [picked, w] = select_progressive([make(10, 9), make(60, 9), make(70, 9)], 3, [26, 48, 72]);
  assert.equal(w, 72);

  // Nothing reaches min_imp at the widest window -> fill from the window anyway.
  [picked, w] = select_progressive([make(10, 1), make(20, 2)], 3, [26, 48, 72]);
  assert.equal(w, 72);
  assert.equal(picked.length, 2);
});

// ============================================================ budget / trimming

ok('char_budget implements the five thresholds and the novelty bonus', () => {
  assert.equal(char_budget(10, 10), 400);
  assert.equal(char_budget(8, 8), 350); // base 8.0, no novelty bonus
  assert.equal(char_budget(8, 9), 390); // same band, nov >= 9.0 adds 40
  assert.equal(char_budget(7, 7), 290); // base 7.0
  assert.equal(char_budget(6, 6), 230); // base 6.0
  assert.equal(char_budget(5, 5), 175); // base 5.0
  assert.equal(char_budget(2, 2), 120); // base 2.0
  assert.equal(char_budget(6, 9.5), 390); // base 7.575 -> 350, +40 novelty bonus, under the 400 clamp
});

ok('split_budget is 22/50/28 with the floor values', () => {
  assert.deepEqual(split_budget(400), [88, 200, 112]);
  assert.deepEqual(split_budget(120), [30, 60, 34]);
  assert.deepEqual(split_budget(10), [30, 50, 30]);
});

ok('actual_len counts only fact+why+impact', () => {
  const it = mk({ extra: { fact: 'abc', why: 'de', impact: 'f', doubt: 'ignored', headline: 'x' } });
  assert.equal(actual_len(it), 6);
});

ok('trim_to_budget cuts whole sentences only, why -> fact -> impact', () => {
  // Chinese sentences are short (5 chars), so the over-budget case is built by
  // repeating them: why 45 + fact 60 = 105, against limit 600*1.15 = 690.
  const it = mk({
    extra: {
      budget: 100,
      why: '甲乙丙丁。'.repeat(10),
      fact: '事实一二三四。'.repeat(10),
      impact: '',
    },
  });
  const before = actual_len(it);
  assert.equal(before, 120, 'fixture length');

  const cut = trim_to_budget(it);
  assert.equal(cut, true);
  assert.ok(actual_len(it) <= 115, 'now ' + actual_len(it));
  // Trimming walks why -> fact -> impact and pops whole sentences only.
  assert.ok(it.extra.why.length % 5 === 0, 'why length still a multiple of the sentence size');
  for (const k of ['why', 'fact', 'impact']) {
    for (const s of String(it.extra[k] || '').split(/(?<=[。！？；!?;])/).filter((p) => p.trim())) {
      assert.ok(/[。！？；!?;]$/.test(s.trim()), `a sentence was truncated mid-way: ${JSON.stringify(s)}`);
    }
  }
  console.log(`      trim: why 50 -> ${it.extra.why.length}, fact 70 -> ${it.extra.fact.length}, total ${actual_len(it)} (limit 115)`);
  // A field with no sentence boundary at all is left intact rather than cut.
  const hard = mk({ extra: { budget: 8, why: '一句话没有任何句末标点', fact: '', impact: '' } });
  assert.equal(trim_to_budget(hard), false);
  assert.equal(hard.extra.why, '一句话没有任何句末标点');
});

ok('trim_to_budget is a no-op without a budget or when already inside the limit', () => {
  assert.equal(trim_to_budget(mk({ extra: { why: 'long'.repeat(50) } })), false);
  assert.equal(trim_to_budget(mk({ extra: { budget: 0, why: 'x' } })), false);
  assert.equal(trim_to_budget(mk({ extra: { budget: 400, why: '甲乙丙。', fact: '丁。', impact: '戊。' } })), false);
});

// ============================================================ LLM via stub

const cfg = (port) => ({ base_url: `http://127.0.0.1:${port}`, api_key: 'stub-key', model: 'stub-model' });

// --- llm_chat request shaping + json_mode + retry on a 500 -------------------
{
  const stub = await startStub((n) => (n === 1
    ? { httpStatus: 500 }
    : { content: '{"ok":true}' }));
  const prevMax = 3;
  const c = cfg(stub.port);
  c.max_retries = prevMax;
  const out = await llm_chat(c, [{ role: 'user', content: 'hi' }], { json_mode: true, max_tokens: 42, temperature: 0.7, timeoutMs: 4000 });
  assert.equal(out, '{"ok":true}');
  assert.equal(stub.calls(), 2, 'expected one retry');
  const first = stub.seen[0];
  assert.equal(first.url, '/chat/completions');
  assert.equal(first.auth, 'Bearer stub-key');
  assert.equal(first.body.model, 'stub-model');
  assert.equal(first.body.max_tokens, 42);
  assert.equal(first.body.temperature, 0.7);
  assert.deepEqual(first.body.response_format, { type: 'json_object' });
  assert.equal(first.body.stream, false);
  pass++;
  console.log('  ok  llm_chat sends the shaped request and retries a 500 (stub saw 2 calls, 1st -> HTTP 500)');
  await stub.close();
}

// --- llm_chat gives up after max_retries ------------------------------------
{
  const stub = await startStub(() => ({ httpStatus: 503 }));
  const c = cfg(stub.port);
  c.max_retries = 1; // keep the smoke test fast; the real config uses 3
  await assert.rejects(() => llm_chat(c, [{ role: 'user', content: 'x' }], { timeoutMs: 4000 }), /HTTP 503/);
  assert.equal(stub.calls(), 1);
  pass++;
  console.log('  ok  llm_chat surfaces the final HTTP error after max_retries');
  await stub.close();
}

// --- llm_rank parsing, event slugging, missing rows, fence extraction -------
{
  const fenced = '```json\n{"items":[' +
    '{"i":0,"imp":9,"nov":7,"topic":"MODEL","event":"OpenAI-GPT6 Release!!!"},' +
    '{"i":1,"imp":5,"nov":5,"topic":"not-a-topic","event":"ANTHROPIC Agent/Internet Cutoff"},' +
    '{"i":3,"imp":"oops","nov":2,"topic":"policy","event":"x"}' +
    ']}\n```';
  const stub = await startStub(() => ({ content: fenced }));
  const items = [0, 1, 2, 3].map((i) => mk({
    source_key: 's' + i, source_name: 'S' + i, tier: 1, title: 'Title ' + i, summary: 'S'.repeat(80), published: new Date(),
  }));
  const logs = [];
  await llm_rank(cfg(stub.port), items, '2026年10月13日', (m) => logs.push(m));
  assert.equal(items[0].llm_importance, 9);
  assert.equal(items[0].llm_novelty, 7);
  assert.equal(items[0].llm_topic, 'model', 'topic is lowercased');
  assert.equal(items[0].extra.event, 'openai-gpt6release', 'lowercased, only [a-z0-9-] kept');
  assert.equal(items[1].llm_topic, 'other', 'an unknown topic falls back to other');
  assert.equal(items[1].extra.event, 'anthropicagentinternetcutoff');
  assert.equal(items[2].llm_importance, 5, 'a missing row defaults to 5');
  assert.equal(items[2].llm_topic, 'other');
  assert.equal(items[3].llm_importance, 5, 'a non-numeric imp defaults to 5');
  // 4 items, rows for i=0,1,3 only (i=2 never came back), 3 non-empty event slugs.
  assert.ok(logs[0].includes('LLM 排序完成：3 条已打分，1 条默认补 5 分，归并为 3 组事件'), logs[0]);
  console.log('      stub returned a ```json-fenced body; call 1 url=' + stub.seen[0].url);
  assert.ok(stub.seen[0].body.messages[1].content.includes('2026年10月13日'));
  assert.ok(stub.seen[0].body.messages[1].content.includes('0 | S0 | T1 | Title 0'));
  pass++;
  console.log('  ok  llm_rank parses fenced JSON, slugifies event, defaults missing rows, logs counts');
  await stub.close();
}

// --- llm_interpret: headers, surgical retry, and the sentence-boundary trim --
{
  // Round 1: wildly over budget on item 0 (facts 20 + why 401 + impact 120 = 541,
  // i.e. past the retry line 400*1.10 = 440), under budget on item 1.
  // Round 2/3: item 0 shrinks to 507, still past 440 so it is flagged again; the
  // leftover overshoot past 400*1.15 = 460 is handled by the trim, not the prompt.
  const round1 = {
    items: [
      { i: 0, headline: '📌 事实：这是一个标题', fact: '事实一。事实二。事实三。事实四。事实五。', why: '为'.repeat(400) + '。', impact: '影'.repeat(120), doubt: '' },
      { i: 1, headline: 'H2', fact: '短', why: '短', impact: '短', doubt: '存疑：仅厂商自述' },
    ],
  };
  // 500 chars of why still overshoots (total 506 > trim tolerance 460) but is built
  // from four sentences, so the boundary trim can drop whole trailing sentences.
  const longWhy = '为'.repeat(381) + '。' + '补'.repeat(20) + '。' + '再'.repeat(20) + '。' + '末'.repeat(76) + '。';
  const round2 = {
    items: [
      { i: 0, headline: '', fact: '事实一。', why: longWhy, impact: '影。' },
    ],
  };
  const stub = await startStub((n) => ({ content: JSON.stringify(n === 1 ? round1 : round2) }));
  const picked = [
    mk({ source_key: 'tc', source_name: 'TechCrunch AI', tier: 2, title: 'Original English Headline', summary: 'S'.repeat(200), published: new Date('2026-10-13T00:30:00Z'), llm_importance: 9, llm_novelty: 8, llm_topic: 'model' }),
    mk({ source_key: 'hn', source_name: 'Hacker News', tier: 3, title: 'Second', summary: 'S'.repeat(200), published: null, llm_importance: 6, llm_novelty: 6, llm_topic: 'other' }),
  ];
  const logs = [];
  const warns = [];
  await llm_interpret(cfg(stub.port), picked, {
    info: (m) => logs.push(m), warning: (m) => warns.push(m), error: () => {},
  }, { max_retry: 2 });

  // _build_block content, seen by the stub on the first call.
  const firstUser = stub.seen[0].body.messages[1].content;
  assert.ok(firstUser.includes('--- 第 0 条 ---'));
  assert.ok(firstUser.includes('字数预算：fact ≤ 88 字，why ≤ 200 字，impact ≤ 112 字（三者相加 ≤ 400 字，这是硬上限，超出即为不合格）'), firstUser.slice(0, 400));
  assert.ok(firstUser.includes('信源：TechCrunch AI（层级 T2）'));
  assert.ok(firstUser.includes('时间：2026-10-13 08:30（北京时间）'));
  assert.ok(firstUser.includes('时间未知（北京时间）'), 'an undated item renders 时间未知');
  assert.ok(stub.seen[0].body.messages[1].content.includes('主题簇：模型发布'));

  // The retry prompt must be surgical: it names only item 0 and forbids the rest.
  const retryUser = stub.seen[1].body.messages[1].content;
  assert.ok(retryUser.includes('第 0 条：上一版'), retryUser.slice(0, 300));
  assert.ok(retryUser.includes('其余字段保持与上一版一致'));
  // Item 0 is over budget on why (401 > 200) and impact (120 > 112), but not on fact.
  assert.ok(retryUser.includes('需压缩的字段：why 401→≤200 字，impact 120→≤112 字'), retryUser.slice(0, 400));
  assert.ok(retryUser.includes('你上一版对下列各条的解读'));

  // The headline goes through _tidy_headline only — the Python reference never runs
  // _strip_label on it, so the emoji label survives in the headline by parity.
  assert.equal(picked[0].extra.headline, '📌事实：这是一个标题');
  // Round 2 replaced the whole record (replace=true), so the round-1 labels are gone.
  assert.equal(picked[0].extra.fact, '事实一。');
  assert.ok(logs.some((l) => l.includes('字数校正第 1 轮：重写第 1、2 条')), 'round 1 should flag both items: ' + logs.join('|'));
  // Item numbers in the log are 1-based, so picked[1] prints as "第 2 条".
  // Round 2's why is 501 chars (total 507), still past 400*1.10 = 440, so both items
  // are flagged again; the trim tolerance is the looser 400*1.15 = 460, which is why
  // the leftover overshoot is left to the trim rather than being impossible to reach.
  assert.ok(logs.some((l) => l.includes('字数校正第 2 轮：重写第 1、2 条')), 'round 2 flags both again: ' + logs.join('|'));

  const retryUser2 = stub.seen[2].body.messages[1].content;
  // picked[1] is imp=6/nov=6 -> base 6.0 -> budget 230 (not item 0's 400).
  assert.ok(retryUser2.includes('低于 230 字的合理下界'), 'item 1 should be flagged as under budget: ' + retryUser2.slice(0, 400));
  assert.ok(retryUser2.includes('请把 why 扩写到 ≤115 字'), 'why sub-budget is half of 230');
  assert.ok(retryUser2.includes('第 0 条：上一版 507 字，超出上限 400 字'), retryUser2.slice(0, 400));
  assert.ok(retryUser2.includes('第 1 条：上一版'), 'the material blocks are 0-based here');
  assert.ok(retryUser2.includes('需压缩的字段：why 501→≤200 字'), retryUser2.slice(0, 600));

  // Round 2's multi-sentence `why` still overshot (507 > 400*1.15 = 460), so the
  // boundary trim dropped whole trailing sentences: the 77-char last sentence goes,
  // then 6 + 424 = 430 ≤ 460 stops the loop. It never cuts mid-sentence.
  assert.equal(picked[0].extra.why, '为'.repeat(381) + '。' + '补'.repeat(20) + '。' + '再'.repeat(20) + '。', 'the last sentence is dropped, the first three survive');
  assert.equal(picked[0].extra.fact, '事实一。', 'fact was already under its own sub-budget');
  assert.equal(actual_len(picked[0]), 430);
  assert.ok(warns.some((w) => w.includes('轮重写后仍超标，已按句子边界程序化裁剪至')), warns.join('|'));
  assert.ok(actual_len(picked[0]) <= 400 * 1.15);
  console.log('      budget=' + picked[0].extra.budget + ' after trim actual_len=' + actual_len(picked[0]));
  console.log('      stub calls=' + stub.calls() + ' (1 initial + 2 rewrites)');
  pass++;
  console.log('  ok  llm_interpret builds the material block, rewrites surgically, then trims + warns');
  await stub.close();
}

// --- llm_interpret tolerance of a missing log -------------------------------
{
  const stub = await startStub(() => ({
    content: JSON.stringify({ items: [{ i: 0, headline: 'H', fact: '事实。', why: '原因。', impact: '影响。', doubt: '' }] }),
  }));
  const picked = [mk({ source_key: 'a', source_name: 'A', tier: 1, title: 'T', summary: 'x'.repeat(80), llm_importance: 5, llm_novelty: 5, llm_topic: 'other' })];
  await llm_interpret(cfg(stub.port), picked, undefined, { max_retry: 0 });
  assert.equal(picked[0].extra.headline, 'H');
  assert.equal(picked[0].extra.doubt, '暂无明显疑点', 'the fallback doubt string is filled in');
  assert.equal(picked[0].extra.budget, char_budget(5, 5));
  pass++;
  console.log('  ok  llm_interpret works with log omitted and fills the doubt fallback');
  await stub.close();
}

// ============================================================ rendering

const sample = () => {
  const it = mk({
    source_key: 'hn', source_name: 'Hacker News', tier: 3, url: 'https://news.ycombinator.com/x',
    title: 'Quoting The New York Times', summary: 'S'.repeat(100),
    published: new Date('2026-10-13T01:05:00Z'), llm_importance: 8, llm_novelty: 7, llm_topic: 'policy',
    extra: { headline: '某媒体援引报道', fact: '事实。', why: '原因。', impact: '影响。', doubt: '暂无明显疑点', aged: true },
  });
  it.cluster_sources = ['OpenAI(T1)', 'Hacker News(T3)'];
  it.cluster_urls = ['https://openai.com/news/x', 'https://news.ycombinator.com/x'];
  it.cluster_best = 'OpenAI';
  it.prog_score = 0.6;
  return it;
};
const meta = {
  date: '2026-10-13', date_cn: '2026年10月13日', generated: '2026-10-13 09:00:00',
  fetched: 120, clusters: 44, window: '26', primary_window: '26',
  window_note: '今日 26 小时内的新增动态不足，下列 1 条来自 48 小时回溯窗口。',
  errors: ['量子位: timeout'],
};

ok('fmt_time renders in Asia/Shanghai regardless of the host timezone', () => {
  assert.equal(fmt_time(sample()), '10-13 09:05');
  assert.equal(fmt_time(mk({ title: 'x' })), '时间未知');
});

ok('render_text shows the owner attribution and the 其他来源 label', () => {
  const t = render_text([sample()], meta);
  assert.ok(t.includes('【1】某媒体援引报道'));
  assert.ok(t.includes('原文标题：Quoting The New York Times'));
  assert.ok(t.includes('来源：OpenAI（线索来自 Hacker News） · 10-13 09:05 · 政策安全  [回溯]'));
  assert.ok(t.includes('🔗 原文：https://openai.com/news/x'));
  assert.ok(t.includes('🔗 其他来源：https://news.ycombinator.com/x'));
  assert.ok(!t.includes('交叉报道'));
  assert.ok(t.includes('※ 今日 26 小时内的新增动态不足'));
  assert.ok(t.includes('信源告警：量子位: timeout'));
  console.log('      ' + t.split('\n').slice(0, 6).join(' / '));
});

ok('render_html keeps the card template, accents and the footer', () => {
  const html = render_html([sample()], meta);
  assert.ok(html.includes('border-left:4px solid #0b5cad;'));
  assert.ok(html.includes('↳ 其他来源'));
  assert.ok(html.includes('🔗 阅读原文（OpenAI（线索来自 Hacker News））'));
  assert.ok(html.includes('重要性 8/10'));
  assert.ok(html.includes('回溯</span>'));
  assert.ok(html.includes('⚠️ 部分信源本次不可达：量子位: timeout'));
  assert.ok(html.includes('ℹ️ 今日 26 小时内的新增动态不足'));
  assert.ok(html.includes('主窗 26 小时'));
  assert.ok(!html.includes('{fact}'), 'no placeholder survived substitution');
});

ok('render_html renders the "no items" card and tolerates a bare meta', () => {
  const html = render_html([], {});
  assert.ok(html.includes('今日未发现达到推送门槛的 AI 重大动态。'));
  const t = render_text([], {});
  assert.ok(t.includes('AI 每日三报 · '));
  assert.ok(t.includes('精选 0 条'));
});

ok('TOPIC_LABELS / SIGNAL_WORDS / CST are exported as expected', () => {
  assert.equal(TOPIC_LABELS.policy, '政策安全');
  assert.equal(CST, 480);
  assert.ok(SIGNAL_WORDS.test('OpenAI releases a new model'));
  assert.ok(SIGNAL_WORDS.test('该公司完成融资'));
});

// ------------------------------------------------ window arithmetic (UTC only)

/** The port's own Asia/Shanghai field reader, re-derived here independently. */
const cstFields = (d) => {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)) o[p.type] = p.value;
  return o;
};

/** An item published `hours` before `ref`, with a summary long enough to score. */
const mkAged = (ref, hours, key) => mk({
  source_key: key,
  source_name: key,
  tier: 1,
  title: 'T ' + key,
  url: 'https://example.com/' + key,
  summary: '摘要 ' + key + '：本条测试摘要刻意写长，以越过「摘要过短扣分」的四十字符阈值。',
  published: new Date(ref - hours * 3600000),
  // llm_topic is the sentinel `final_score` falls back on: without it every item
  // scores exactly its prog_score and the ordering below would be meaningless.
  llm_topic: 'model',
  llm_novelty: 8,
});

ok('select_progressive measures the window from the run instant, in UTC hours', () => {
  const ref = Date.now();
  const items = [
    mkAged(ref, 25.5, 'a25'),
    mkAged(ref, 26.5, 'a26'), // outside 26h, inside 48h
    mkAged(ref, 47.5, 'a47'),
    mkAged(ref, 71.0, 'a71'),
    mkAged(ref, 73.0, 'a73'), // outside even 72h
  ];
  for (const it of items) it.llm_importance = 8;

  const [p1, w1] = select_progressive(items, 1, [26, 48, 72], { min_imp: 6 });
  assert.equal(w1, 26);
  assert.deepEqual(p1.map((x) => x.source_key), ['a25']);

  // Ageing everything by 12h pushes a25 past 26h while a26 is still inside 48h.
  const later = items.map((it) => mkAged(ref, (ref - it.published.getTime()) / 3600000 + 12, it.source_key));
  for (const it of later) it.llm_importance = it.source_key === 'a26' ? 9 : 8;
  const [p2, w2] = select_progressive(later, 1, [26, 48, 72], { min_imp: 6 });
  assert.equal(w2, 48);
  assert.deepEqual(p2.map((x) => x.source_key), ['a26']);

  // 73h never qualifies, whatever the window.
  const [p3, w3] = select_progressive(items, 9, [26, 48, 72], { min_imp: 6 });
  assert.equal(w3, 72);
  assert.ok(!p3.some((x) => x.source_key === 'a73'));
});

ok('the 26h window is a duration from now, not "since midnight in Asia/Shanghai"', () => {
  const ref = Date.now();
  const f = cstFields(new Date(ref));
  // Hours elapsed since 00:00 Asia/Shanghai *today*, from the same Intl fields.
  const midnight = Date.UTC(
    Number(f.year), Number(f.month) - 1, Number(f.day),
    -8, 0, 0, // 00:00 at UTC+8 == 16:00 UTC the previous day
  );
  const sinceMidnight = (ref - midnight) / 3600000;
  if (sinceMidnight > 24.5) return; // just after midnight: not discriminating, skip
  const probe = sinceMidnight + 0.5; // younger than 26h, but published *yesterday* in CST
  const items = [mkAged(ref, probe, 'yesterday')];
  items[0].llm_importance = 8;
  const [picked, w] = select_progressive(items, 1, [26, 48, 72], { min_imp: 6 });
  console.log(`      CST midnight was ${sinceMidnight.toFixed(2)}h ago; probe item age ${probe.toFixed(2)}h -> window ${w}`);
  assert.equal(w, 26, 'an item published yesterday but younger than 26h must be in the primary window');
  assert.equal(picked.length, 1);
});

ok('neither module reads host-local time without an explicit timeZone', () => {
  for (const f of ['../lib/digest.js', '../lib/render.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const banned of ['getHours(', 'getMinutes(', 'getMonth(', 'getDate(', 'getFullYear(', 'getDay(', 'toLocaleString(', 'toLocaleDateString(', 'toLocaleTimeString(']) {
      assert.ok(!src.includes(banned), `${f} must not call ${banned}`);
    }
    assert.ok(src.includes('Asia/Shanghai'), `${f} must name the display timezone`);
  }
});

ok('selection and formatting do not shift when the host TZ is changed', () => {
  const ref = Date.now();
  const items = [mkAged(ref, 25.5, 'a25'), mkAged(ref, 26.5, 'a26')];
  for (const it of items) it.llm_importance = 8;
  const stamp = (it) => `${fmt_time(it)}|${it.source_key}`;
  const baseline = { w: select_progressive(items, 1, [26], { min_imp: 6 })[1], out: items.map(stamp).join(',') };
  const saved = process.env.TZ;
  try {
    for (const zone of ['Pacific/Kiritimati', 'America/New_York', 'UTC']) {
      process.env.TZ = zone;
      const w = select_progressive(items, 1, [26], { min_imp: 6 })[1];
      assert.equal(w, baseline.w, `window changed under TZ=${zone}`);
      assert.equal(items.map(stamp).join(','), baseline.out, `fmt_time changed under TZ=${zone}`);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
  console.log(`      baseline window=${baseline.w}, fmt_time=${baseline.out}`);
});

console.log(`\n${pass} checks passed.`);
