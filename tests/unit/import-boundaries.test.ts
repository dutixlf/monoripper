import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkApp, defineApp } from '../../src/index'

async function fixture(files: Record<string, string>, run: (root: string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'monoripper-imports-'))
  try {
    for (const [name, source] of Object.entries({
      'user/index.ts': 'export default {}', 'billing/index.ts': 'export default {}', ...files,
    })) {
      const path = join(root, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, source)
    }
    run(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}
const app = defineApp({ project: 'lint', contexts: {
  user: { entry: './user/index.ts', owns: [{ method: '*', path: '/user/*' }] },
  billing: { entry: './billing/index.ts', owns: [{ method: '*', path: '/billing/*' }] },
} })

test('shared utilities are allowed and modules are parsed, never executed', async () => {
  await fixture({
    'user/index.ts': 'import { value } from "../shared"; throw new Error("do not execute"); export {value}',
    'billing/index.ts': 'export {value} from "../shared"',
    'shared.ts': 'export const value=42',
  }, root => expect(checkApp(app, { root })).toEqual([]))
})

test('cross-context aliases resolve against tsconfig and report file/line', async () => {
  await fixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }),
    'user/index.ts': '\nimport { value } from "@/billing/service"; export {value}',
    'billing/service.ts': 'export const value=42',
  }, root => {
    const errors = checkApp(app, { root })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'IMPORT_BOUNDARY_VIOLATION', line: 2, file: join(root, 'user/index.ts') })
  })
})

test('shared barrel cannot hide a dependency on a context', async () => {
  await fixture({
    'user/index.ts': 'export {value} from "../shared/index"',
    'shared/index.ts': 'export {value} from "../billing/service"',
    'billing/service.ts': 'export const value=42',
  }, root => expect(checkApp(app, { root })).toEqual([
    expect.objectContaining({ code: 'IMPORT_BOUNDARY_VIOLATION', file: join(root, 'shared/index.ts') }),
  ]))
})

test('literal dynamic import, require and type imports follow the same boundary', async () => {
  for (const source of ['import("../billing/service")', 'require("../billing/service")', 'export type X=import("../billing/service").X']) {
    await fixture({ 'user/index.ts': source, 'billing/service.ts': 'export type X=string' }, root => {
      expect(checkApp(app, { root })).toContainEqual(expect.objectContaining({ code: 'IMPORT_BOUNDARY_VIOLATION' }))
    })
  }
})

test('computed imports and unresolved local imports fail closed', async () => {
  await fixture({ 'user/index.ts': 'const path="./missing"; import(path); import "./absent"' }, root => {
    const codes = checkApp(app, { root }).map(error => error.code)
    expect(codes).toContain('UNSUPPORTED_DYNAMIC_IMPORT')
    expect(codes).toContain('UNRESOLVED_IMPORT')
  })
})
