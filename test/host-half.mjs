/**
 * Load the host half the way DSH would, but with stubbed `@deepseek-ai/*`
 * packages, so a wrong import name / registration shape fails here instead of
 * silently inside the app. Cleans up the stubs it creates.
 *
 *   node tmp/load-host.mjs
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const stubRoot = path.join(root, 'node_modules', '@deepseek-ai')

const SCHEMASTERy = `
const chain = () => {
  const node = {
    default: () => node,
    description: () => node,
    required: () => node,
    object: () => node,
    string: () => node,
    number: () => node,
    boolean: () => node,
    array: () => node,
  }
  return node
}
export default { object: chain, string: chain, number: chain, boolean: chain, array: chain }
`

const TOOLS = `
/**
 * Mirrors the checks the real @deepseek-ai/dsh-tools performs at defineTool()
 * time — most importantly the one that only fires *inside a running app*:
 * an object-typed parameter or property must state additionalProperties
 * explicitly. The live error was:
 *   JsonSchemaError: unsupported JSON schema:
 *   parameters.set.additionalProperties must be explicitly true or false
 * Reproducing it here means an offline test run catches it instead.
 */
function validateSpecMap(map, trail) {
  if (!map || typeof map !== 'object') throw new Error('schema map required at ' + trail)
  for (const [key, node] of Object.entries(map)) {
    validateNode(node, trail + '.' + key)
  }
}
function validateNode(node, trail) {
  if (!node || typeof node !== 'object') throw new Error('schema node must be an object at ' + trail)
  if (node.type === 'object') {
    if (!Object.prototype.hasOwnProperty.call(node, 'additionalProperties')) {
      throw new Error('unsupported JSON schema: ' + trail + '.additionalProperties must be explicitly true or false')
    }
    if (typeof node.additionalProperties !== 'boolean') {
      throw new Error('unsupported JSON schema: ' + trail + '.additionalProperties must be a boolean')
    }
    if (node.properties) validateSpecMap(node.properties, trail + '.properties')
    if (node.additionalProperties === false && !node.properties) {
      throw new Error('unsupported JSON schema: ' + trail + ' sets additionalProperties false with no properties')
    }
  }
  if (node.type === 'array') {
    if (!node.items || typeof node.items !== 'object') throw new Error('unsupported JSON schema: ' + trail + '.items required')
    validateNode(node.items, trail + '.items')
  }
}
export function defineTool(spec) {
  if (!spec || typeof spec.name !== 'string') throw new Error('defineTool: name required')
  if (typeof spec.execute !== 'function') throw new Error('defineTool: execute required for ' + spec.name)
  if (!spec.parameters || typeof spec.parameters !== 'object') throw new Error('defineTool: parameters required for ' + spec.name)
  validateSpecMap(spec.parameters, 'parameters')
  if (!spec.output || !spec.output.schema) throw new Error('defineTool: output.schema required for ' + spec.name)
  validateNode(spec.output.schema, 'output.schema')
  return spec
}
`

await fsp.mkdir(path.join(stubRoot, 'schemastery'), { recursive: true })
await fsp.mkdir(path.join(stubRoot, 'dsh-tools'), { recursive: true })
await fsp.writeFile(path.join(stubRoot, 'schemastery', 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0', type: 'module', main: 'index.js' }))
await fsp.writeFile(path.join(stubRoot, 'schemastery', 'index.js'), SCHEMASTERy)
await fsp.writeFile(path.join(stubRoot, 'dsh-tools', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.js' }))
await fsp.writeFile(path.join(stubRoot, 'dsh-tools', 'index.js'), TOOLS)

const tools = []
const routes = []
const effects = []
const sections = []
const logs = []

const fakeCtx = {
  logger: {
    info: (...a) => logs.push(['info', a.map(String).join(' ')]),
    warn: (...a) => logs.push(['warn', a.map(String).join(' ')]),
    error: (...a) => logs.push(['error', a.map(String).join(' ')]),
    debug: () => {},
  },
  tools: { register: (tool) => tools.push(tool) },
  systemPrompt: { section: (section) => sections.push(section) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  effect: (fn, label) => { effects.push(label); const d = fn(); return () => { if (typeof d === 'function') d() } },
  get: () => undefined,
}

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  [ OK ] ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  [FAIL] ${label}\n         ${error.message}`)
  }
}

try {
  const mod = await import('../lib/index.js')

  console.log('== 入口 shim 与元数据 ==')
  check('name 是 dsh-auto-email', () => assert.equal(mod.name, 'dsh-auto-email'))
  check('inject 声明了 tools 与 webServer', () => {
    assert.ok(mod.inject.includes('tools'), 'tools')
    assert.ok(mod.inject.includes('webServer'), 'webServer')
  })
  check('Config 存在且是 schemastery 形状', () => assert.equal(typeof mod.Config?.object, 'function'))
  check('apply 是 async 函数', () => assert.equal(typeof mod.apply, 'function'))

  await mod.apply(fakeCtx, {})

  console.log('== 注册面 ==')
  check('注册了 4 个工具', () => assert.equal(tools.length, 4))
  check('4 个工具名各不相同且是平台约定的下划线小写', () => {
    const names = tools.map((t) => t.name)
    assert.equal(new Set(names).size, 4)
    // `agnes_generate_image` is the on-disk precedent: DSH tool names are
    // snake_case, not kebab-case.
    for (const n of names) {
      assert.match(n, /^[a-z][a-z0-9_]*$/, n)
      assert.ok(n.startsWith('dsh_auto_email_'), n)
    }
  })
  check('每个工具都带 description 与 output.render', () => {
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 20, `${t.name} description`)
      assert.equal(typeof t.output?.render, 'function', `${t.name} render`)
    }
  })
  check('每个工具的参数项都带 type 与 description', () => {
    for (const t of tools) {
      for (const [key, spec] of Object.entries(t.parameters ?? {})) {
        assert.ok(spec.type, `${t.name}.${key} type`)
        assert.ok(spec.description, `${t.name}.${key} description`)
      }
    }
  })
  check('注册了 8 条路由，全是 exact 且 path 以 /api/ 开头', () => {
    assert.equal(routes.length, 8)
    for (const r of routes) {
      assert.equal(r.kind, 'exact', r.path)
      assert.match(r.path, /^\/api\//, r.path)
      assert.equal(typeof r.handler, 'function', r.path)
    }
  })
  check('路由 path 互不重复', () => {
    const paths = routes.map((r) => r.path)
    assert.equal(new Set(paths).size, paths.length)
  })
  check('注册了 systemPrompt 段，order 落在 100-199', () => {
    assert.equal(sections.length, 1)
    assert.ok(sections[0].order >= 100 && sections[0].order < 200, String(sections[0].order))
    assert.ok(sections[0].text.length > 50, 'section text')
  })
  check('两个 ctx.effect 都带 label', () => {
    assert.equal(effects.length, 2)
    for (const label of effects) assert.ok(typeof label === 'string' && label.length > 0, String(label))
  })
  check('启动日志里说明了数据目录', () => {
    assert.ok(logs.some(([, line]) => line.includes('dsh-auto-email')), JSON.stringify(logs.slice(0, 3)))
  })

  console.log('== 工具输出 schema ==')
  check('每个工具的 output.schema 是 object 且 properties 非空', () => {
    for (const t of tools) {
      assert.equal(t.output.schema.type, 'object', t.name)
      assert.ok(Object.keys(t.output.schema.properties ?? {}).length > 0, t.name)
    }
  })
  check('presentCall 返回已知的 card 形状', () => {
    for (const t of tools) {
      if (typeof t.presentCall !== 'function') continue
      const call = t.presentCall({})
      assert.ok(['generic', 'shell', 'diff', 'read'].includes(call.card), `${t.name} card=${call.card}`)
    }
  })

  console.log('== 桩本身可信吗（test the test）==')
  // Without this, the schema rule above could pass vacuously and the next live
  // JsonSchemaError would again only show up inside the running app.
  const { defineTool } = await import(pathToFileURL(path.join(stubRoot, 'dsh-tools', 'index.js')).href)
  const minimal = { name: 'x', execute: () => {}, output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } } } }
  check('桩会拒绝未声明 additionalProperties 的对象参数（即线上踩到的那个错）', () => {
    assert.throws(
      () => defineTool({ ...minimal, parameters: { set: { type: 'object', description: 'd' } } }),
      /additionalProperties must be explicitly true or false/,
    )
  })
  check('桩会接受显式声明 additionalProperties 的对象参数', () => {
    assert.doesNotThrow(() => defineTool({ ...minimal, parameters: { set: { type: 'object', additionalProperties: true, description: 'd' } } }))
  })
  check('桩会拒绝没有 items 的数组参数', () => {
    assert.throws(() => defineTool({ ...minimal, parameters: { list: { type: 'array', description: 'd' } } }), /items required/)
  })
} finally {
  await fsp.rm(path.join(root, 'node_modules'), { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
