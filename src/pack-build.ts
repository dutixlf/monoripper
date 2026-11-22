import { dirname, resolve } from 'node:path'

/**
 * Child process of `pack`, started with the app root as cwd so Bun's source comments and metadata paths are
 * relative to the app, never to the developer's checkout location. Prints one JSON result line.
 */
interface Input { entrypoints: string[]; outdir: string; external: string[]; sdkEntries: string[]; sdkExports: string[] }
const input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as Input
const sdk = new Set(input.sdkEntries)
const build = await Bun.build({
  entrypoints: input.entrypoints, root: process.cwd(), outdir: input.outdir, target: 'bun', format: 'esm', splitting: true,
  sourcemap: 'none', minify: false, env: 'disable', metafile: true, packages: 'bundle', external: input.external,
  naming: { entry: 'entries/[name]-[hash].[ext]', chunk: 'chunks/[name]-[hash].[ext]', asset: 'assets/[name]-[hash].[ext]' },
  plugins: [{ name: 'monoripper-sdk', setup(builder) {
    builder.onResolve({ filter: /^(\.{1,2})?\// }, args => sdk.has(resolve(dirname(args.importer), args.path)) ? { path: 'shared-sdk', namespace: 'monoripper-sdk' } : undefined)
    // Bun keeps the original specifier for externals; a virtual module re-exports the shared package instead.
    builder.onLoad({ filter: /.*/, namespace: 'monoripper-sdk' }, () => ({ contents: `export { ${input.sdkExports.join(', ')} } from 'monoripper'`, loader: 'js' }))
  } }],
})
console.log(JSON.stringify({ success: build.success, logs: build.logs.map(log => String(log.message ?? log)), metafile: build.metafile }))
