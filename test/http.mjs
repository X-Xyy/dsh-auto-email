/**
 * Throwaway suite for `httpGet`'s retry policy — the contract's §3 rules:
 * 429 honours Retry-After (or backs off 8*(i+1)), clamped to 3-60s, then RETRIES;
 * 403/404/410 give up immediately (deterministic); other statuses retry with backoff;
 * 200 returns the body. Wall-clock waits are measured, not slept through blindly, and
 * a 429 test asserts the server-requested delay was actually respected.
 *
 *   node tmp/httpget-cases.mjs
 */

import { performance } from 'node:perf_hooks';
import { httpGet } from '../lib/sources.js';

let calls = 0;
let seenHeaders = [];

/** Install a fake fetch that walks through `responses` (last one repeats). */
function stub(responses) {
  calls = 0;
  seenHeaders = [];
  globalThis.fetch = async (url, init) => {
    seenHeaders.push(init && init.headers ? init.headers : {});
    const r = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    if (r.throws) throw new TypeError(r.throws);
    const headers = new Headers(r.headers || {});
    return new Response(r.body === undefined ? 'BODY' : r.body, { status: r.status, headers });
  };
}

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

async function expectThrow(name, fn, pred) {
  try {
    const v = await fn();
    record(name, false, `expected a throw, got ${JSON.stringify(v).slice(0, 60)}`);
  } catch (e) {
    record(name, pred(e), `threw ${e.name}: ${e.message}`);
  }
}

// ---- 1. happy path
stub([{ status: 200, body: '<xml>ok</xml>' }]);
{
  const body = await httpGet('https://x.test/f');
  record('200 returns body', body === '<xml>ok</xml>' && calls === 1, `body=${body} calls=${calls}`);
}

// ---- 2. 404 gives up immediately, message keeps the status code
stub([{ status: 404 }, { status: 200 }]);
await expectThrow('404 no retry', () => httpGet('https://x.test/f', { tries: 3 }),
  (e) => /404/.test(e.message) && calls === 1);
record('404 message carries status', /404/.test(String(results.at(-1).detail)), `calls=${calls}`);

// ---- 3. 403 and 410 same
for (const code of [403, 410]) {
  stub([{ status: code }, { status: 200 }]);
  // eslint-disable-next-line no-await-in-loop
  await expectThrow(`${code} no retry`, () => httpGet('https://x.test/f', { tries: 3 }), () => calls === 1);
}

// ---- 4. 500 retries with backoff, then succeeds
stub([{ status: 500 }, { status: 500 }, { status: 200, body: 'RECOVERED' }]);
{
  const t0 = performance.now();
  const body = await httpGet('https://x.test/f', { tries: 4 });
  const ms = performance.now() - t0;
  // backoff is 2**i + jitter for i=0,1 -> ~1s + ~2s = ~3s
  record('500 retries then succeeds', body === 'RECOVERED' && calls === 3 && ms > 1500,
    `calls=${calls} body=${body} ${ms.toFixed(0)}ms`);
}

// ---- 5. all attempts exhausted -> throws the last error
stub([{ status: 503 }]);
await expectThrow('exhausted retries throws', () => httpGet('https://x.test/f', { tries: 2 }),
  (e) => /503/.test(e.message) && calls === 2);
record('exhausted used all tries', calls === 2, `calls=${calls}`);

// ---- 6. network error is retried, then the exception surfaces
stub([{ throws: 'ECONNRESET' }]);
await expectThrow('network error surfaces', () => httpGet('https://x.test/f', { tries: 2 }),
  (e) => /ECONNRESET/.test(e.message) && calls === 2);

// ---- 7. 429 with Retry-After in SECONDS: must wait then succeed
stub([
  { status: 429, headers: { 'Retry-After': '3' } },
  { status: 200, body: 'AFTER-429' },
]);
{
  const t0 = performance.now();
  const body = await httpGet('https://x.test/f', { tries: 3 });
  const ms = performance.now() - t0;
  // clamped to >=3s
  record('429 Retry-After:3 respected', body === 'AFTER-429' && calls === 2 && ms >= 2800 && ms < 6000,
    `calls=${calls} ${(ms / 1000).toFixed(1)}s`);
}

// ---- 8. 429 with a tiny Retry-After must clamp UP to 3s
stub([
  { status: 429, headers: { 'Retry-After': '0.1' } },
  { status: 200, body: 'CLAMPED' },
]);
{
  const t0 = performance.now();
  const body = await httpGet('https://x.test/f', { tries: 3 });
  const ms = performance.now() - t0;
  record('429 tiny Retry-After clamped to 3s', body === 'CLAMPED' && ms >= 2800, `${(ms / 1000).toFixed(1)}s`);
}

// ---- 9. 429 with a huge Retry-After must clamp DOWN to 60s (do not actually wait it out)
stub([
  { status: 429, headers: { 'Retry-After': '9999' } },
  { status: 200, body: 'CLAMPED-DOWN' },
]);
{
  // Abort early: the clamp is 60s, which is too long for a smoke test. Assert instead that
  // the request is still pending after 2s (i.e. it did NOT ignore the header and retry fast).
  const p = httpGet('https://x.test/f', { tries: 3 });
  await new Promise((r) => setTimeout(r, 2000));
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 50));
  record('429 huge Retry-After waits (clamped, not ignored)', !settled, settled ? 'retried immediately' : 'still waiting after 2s');
  // Do not await p; the process will use the exit below.
}

// ---- 10. 429 with an HTTP-date Retry-After falls back to 8*(i+1), clamped to >=3s
stub([
  { status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } },
  { status: 200, body: 'DATE-HEADER' },
]);
{
  const t0 = performance.now();
  const body = await httpGet('https://x.test/f', { tries: 3 });
  const ms = performance.now() - t0;
  // 8*(0+1)=8s is within the 3-60 clamp, so expect >=3s
  record('429 HTTP-date header -> backoff >=3s', body === 'DATE-HEADER' && ms >= 2800, `${(ms / 1000).toFixed(1)}s`);
}

// ---- 11. headers reach the server (UA + Accept)
stub([{ status: 200 }]);
await httpGet('https://x.test/f');
const h = seenHeaders[0];
record('default headers sent', !!h && !!h['User-Agent'] && /Mozilla/.test(h['User-Agent']),
  JSON.stringify(h));

// ---- 12. explicit headers override the defaults
stub([{ status: 200 }]);
await httpGet('https://x.test/f', { headers: { 'User-Agent': 'custom-agent' } });
record('custom headers win', seenHeaders[0]['User-Agent'] === 'custom-agent',
  JSON.stringify(seenHeaders[0]));

process.stdout.write(`${results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(44)} ${r.detail}`).join('\n')}\n\n`);
process.stdout.write(`httpGet: ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed\n`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
