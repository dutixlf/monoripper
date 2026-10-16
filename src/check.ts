import type ts from 'typescript'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type AppDefinition, MonoripperError } from './definitions'
import { validateApp } from './ownership'

export interface ImportDiagnostic { code: string; file: string; line: number; column: number; message: string }
const canonical = (file: string) => { try { return realpathSync(file) } catch { return resolve(file) } }
const within = (file: string, root: string) => file === root || (!relative(root, file).startsWith('..' + sep) && !relative(root, file).startsWith(sep) && relative(root, file) !== '..')

const loadPackage = createRequire(import.meta.url)

/** Static import analysis. Never imports or evaluates application modules. */
export function checkApp(app: AppDefinition, settings: { root?: string } = {}): ImportDiagnostic[] {
  const ts: typeof import('typescript') = loadPackage('typescript')
  validateApp(app)
  const root = resolve(settings.root ?? process.cwd())
  const diagnostics: ImportDiagnostic[] = []
  let options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true }
  const config = app.tsconfig ? resolve(root, app.tsconfig) : ts.findConfigFile(root, ts.sys.fileExists)
  if (config) {
    const loaded = ts.readConfigFile(config, ts.sys.readFile)
    if (loaded.error) throw new MonoripperError('INVALID_TSCONFIG', ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(config))
    const errors = parsed.errors.filter(error => error.code !== 18003) // A graph fixture need not declare include/files.
    if (errors.length) throw new MonoripperError('INVALID_TSCONFIG', errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
    options = { ...options, ...parsed.options }
  }
  const entries = Object.entries(app.contexts).map(([name, context]) => ({
    name, file: canonical(resolve(root, context.entry)), configuredRoot: context.root,
  }))
  const boundaries = entries.map(entry => ({
    name: entry.name,
    root: canonical(entry.configuredRoot ? resolve(root, entry.configuredRoot)
      : entries.some(other => other.name !== entry.name && dirname(other.file) === dirname(entry.file)) ? entry.file : dirname(entry.file)),
  }))
  for (const entry of entries) {
    if (!within(entry.file, boundaries.find(boundary => boundary.name === entry.name)!.root)) {
      throw new MonoripperError('INVALID_CONFIG', `Context ${entry.name} entry is outside its root`)
    }
  }
  for (let i = 0; i < boundaries.length; i++) for (let j = i + 1; j < boundaries.length; j++) {
    if (within(boundaries[i]!.root, boundaries[j]!.root) || within(boundaries[j]!.root, boundaries[i]!.root)) {
      throw new MonoripperError('INVALID_CONFIG', 'Context import roots overlap; set non-overlapping context.root directories')
    }
  }
  const owner = (file: string) => boundaries.find(boundary => within(file, boundary.root))?.name ?? 'shared'
  const visited = new Set<string>()
  const sdkDirectory = dirname(fileURLToPath(import.meta.url))
  const resolver = ts.createModuleResolutionCache(root, value => value, options)
  function scan(file: string) {
    file = canonical(file)
    if (visited.has(file)) return
    visited.add(file)
    const text = ts.sys.readFile(file)
    if (text === undefined) {
      diagnostics.push({ code: 'UNRESOLVED_IMPORT', file, line: 1, column: 1, message: 'Cannot read module' })
      return
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const report = (node: ts.Node, code: string, message: string) => {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source))
      diagnostics.push({ code, file, line: position.line + 1, column: position.character + 1, message })
    }
    function dependency(node: ts.Node, expression: ts.Node | undefined) {
      if (!expression || (!ts.isStringLiteralLike(expression))) {
        report(node, 'UNSUPPORTED_DYNAMIC_IMPORT', 'Use a literal module specifier; computed imports cannot be checked')
        return
      }
      const specifier = expression.text
      if (isBuiltin(specifier) || specifier === 'bun' || specifier.startsWith('bun:')) return
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys, resolver).resolvedModule
      if (!resolved) {
        report(node, 'UNRESOLVED_IMPORT', `Cannot resolve ${specifier}`)
        return
      }
      const target = canonical(resolved.resolvedFileName)
      // External packages are libraries, not application context roots. SDK source
      // imports in development fixtures are equivalent to importing published monoripper.
      if (target.includes(sep + 'node_modules' + sep) || (within(target, sdkDirectory) && owner(target) === 'shared')) return
      const from = owner(file)
      const to = owner(target)
      if (to !== 'shared' && from !== to) report(node, 'IMPORT_BOUNDARY_VIOLATION', `${from} cannot import ${to}: ${specifier}; move shared logic into a shared module`)
      if (!target.endsWith('.d.ts') && ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(extname(target))) scan(target)
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) dependency(node, node.moduleSpecifier)
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        dependency(node, node.moduleReference.expression)
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        dependency(node, node.argument.literal)
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        dependency(node, node.arguments[0])
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  for (const entry of entries) scan(entry.file)
  for (const descriptor of Object.values(app.resources ?? {})) scan(resolve(root, descriptor.entry))
  return diagnostics
}
