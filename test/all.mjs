/**
 * Run every offline test suite and report one combined verdict.
 *
 *   node test/all.mjs            # offline suites only
 *   node test/all.mjs --live     # also hit the ten real sources over the network
 *
 * Everything here is offline by default: the LLM and SMTP paths are exercised
 * against local stubs, so `npm test` never spends an API key and never sends
 * mail. The one networked suite is `sources-live.mjs`, and it is opt-in.
 *
 * Suites are spawned with `stdio: 'inherit'` on purpose — a piped child needs a
 * named pipe, which is not always available here.
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const live = process.argv.includes('--live')

const suites = [
  { file: 'render.mjs', what: '邮件渲染（文本 + HTML）' },
  { file: 'plugin.mjs', what: '装配层：配置分层 / 时区 / MIME / 幂等闸门' },
  { file: 'digest.mjs', what: '流水线：聚类 / 打分 / 排序 / 解读 / 字数控制', env: { PY_SIM_FILE: path.join(here, 'difflib-parity.json') } },
  { file: 'digest.mjs', what: '流水线：sim 与 Python difflib 的原始串一致性', env: { PY_SIM_FILE: path.join(here, 'difflib-parity.json'), PY_SIM_RAW: '1' } },
  { file: 'feeds.mjs', what: 'RSS 2.0 / RSS 1.0-RDF / Atom 解析' },
  { file: 'http.mjs', what: 'HTTP 重试、429 Retry-After、确定性失败不重试' },
  { file: 'host-half.mjs', what: 'host 半边：4 个工具 / 8 条路由 / 提示词段' },
]

if (live) suites.push({ file: 'sources-live.mjs', what: '十个真实信源联网抓取' })

const failed = []

for (const suite of suites) {
  console.log(`\n${'='.repeat(72)}\n== ${suite.file}  —  ${suite.what}\n${'='.repeat(72)}`)
  const result = spawnSync(process.execPath, [path.join(here, suite.file)], {
    stdio: 'inherit',
    env: { ...process.env, ...(suite.env ?? {}) },
  })
  if (result.error) {
    console.log(`  [FAIL] 无法启动：${result.error.message}`)
    failed.push(suite)
  } else if (result.status !== 0) {
    failed.push(suite)
  }
}

console.log(`\n${'='.repeat(72)}`)
if (failed.length === 0) {
  console.log(`全部 ${suites.length} 个测试套件通过。`)
  process.exit(0)
}
console.log(`${failed.length}/${suites.length} 个套件失败：`)
for (const suite of failed) console.log(`  - ${suite.file}  (${suite.what})`)
process.exit(1)
