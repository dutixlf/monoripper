import { MonoripperError, type AppDefinition, type Ownership } from './definitions'

const methods = new Set(['*', 'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'])
const has = (object: object, key: string) => Object.hasOwn(object, key)
const fail = (message: string): never => { throw new MonoripperError('INVALID_CONFIG', message) }
const prefix = (path: string) => path.endsWith('/*') ? path.slice(0, -2) : undefined

export function validPath(path: string): boolean {
  if (!path.startsWith('/') || /[?#\\\s]/.test(path) || path.includes('//')) return false
  if (/%(?:2f|5c|2e|25)/i.test(path)) return false
  try {
    const decoded = decodeURIComponent(path)
    return !/[\u0000-\u001f\u007f]/.test(decoded) && !path.split('/').some(p => p === '.' || p === '..')
  } catch { return false }
}

export function coversPath(rule: string, path: string): boolean {
  const base = prefix(rule)
  return base === undefined ? rule === path : base === '' || path === base || path.startsWith(base + '/')
}

export function owns(rules: Ownership[], method: string, path: string): boolean {
  return rules.some(rule => (rule.method === '*' || rule.method === method) && coversPath(rule.path, path))
}

export function validateApp(app: AppDefinition): void {
  if (!app || typeof app !== 'object' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(app.project)) fail('Invalid project name')
  if (!app.contexts || typeof app.contexts !== 'object' || !Object.keys(app.contexts).length) fail('No contexts declared')
  const previous: { name: string; rule: Ownership }[] = []
  for (const [name, context] of Object.entries(app.contexts)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) fail(`Invalid context name: ${name}`)
    if (!context || typeof context.entry !== 'string' || !context.entry) fail(`Missing entry: ${name}`)
    if (!Array.isArray(context.owns) || !context.owns.length) fail(`Missing ownership: ${name}`)
    if (context.resources && (!Array.isArray(context.resources) || new Set(context.resources).size !== context.resources.length)) fail(`Invalid resources: ${name}`)
    for (const resource of context.resources ?? []) {
      const descriptor = app.resources?.[resource]
      if (!descriptor || !Array.isArray(descriptor.contexts) || !descriptor.contexts.includes(name)) {
        throw new MonoripperError('RESOURCE_NOT_ALLOWED', `${name} cannot use resource ${resource}`)
      }
    }
    for (const rule of context.owns) {
      if (!rule || !methods.has(rule.method) || typeof rule.path !== 'string' || !validPath(rule.path)) fail(`Invalid ownership in ${name}`)
      const staticPart = rule.path.endsWith('/*') ? rule.path.slice(0, -2) : rule.path
      if (/[*:]/.test(staticPart)) fail(`Only exact paths and trailing /* are supported: ${rule.path}`)
      for (const old of previous) {
        if (old.name === name) continue
        const methodOverlap = old.rule.method === '*' || rule.method === '*' || old.rule.method === rule.method
        const overlaps = coversPath(old.rule.path, staticPart) || coversPath(rule.path, prefix(old.rule.path) ?? old.rule.path)
        if (methodOverlap && overlaps) throw new MonoripperError('OWNERSHIP_CONFLICT', `${old.name} and ${name} overlap at ${rule.path}`)
      }
      previous.push({ name, rule })
    }
  }
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource || typeof resource.entry !== 'string' || !resource.entry || !Array.isArray(resource.contexts)
      || resource.contexts.some(context => !has(app.contexts, context))) fail(`Invalid resource declaration: ${name}`)
  }
}

/** Conservative check: an Elysia route's whole dynamic pattern must fit one ownership rule. */
export function ownsRoute(rules: Ownership[], method: string, path: string): boolean {
  const routeMethod = method === 'ALL' ? '*' : method
  return rules.some(rule => {
    if (rule.method !== '*' && rule.method !== routeMethod) return false
    const base = prefix(rule.path)
    if (base === undefined) return !/[:*]/.test(path) && path === rule.path
    const firstParameter = path.search(/[:*]/)
    const literal = firstParameter < 0 ? path : path.slice(0, firstParameter)
    return base === '' || (firstParameter < 0 ? coversPath(rule.path, path) : literal.startsWith(base + '/'))
  })
}
