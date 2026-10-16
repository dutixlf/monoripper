import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const project = resolve(import.meta.dir, '..')
async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited !== 0) throw new Error(`Command failed: ${args.slice(0, 3).join(' ')}`)
}
const temp = await mkdtemp(join(tmpdir(), 'monoripper-package-'))
try {
  await run([process.execPath, 'run', 'build'], project)
  await run([process.execPath, 'pm', 'pack', '--ignore-scripts', '--filename', join(temp, 'monoripper.tgz')], project)
  const listing = Bun.spawn(['tar', '-tzf', join(temp, 'monoripper.tgz')], { stdout: 'pipe', stderr: 'inherit' })
  const files = (await new Response(listing.stdout).text()).trim().split('\n')
  if (await listing.exited !== 0 || !files.length) throw new Error('Cannot inspect package archive')
  if (files.some(file => file !== 'package/package.json' && file !== 'package/README.md' && !file.startsWith('package/dist/'))) throw new Error('Unexpected source/fixture/config file in package')
  await writeFile(join(temp, 'package.json'), JSON.stringify({ type: 'module', dependencies: { monoripper: './monoripper.tgz' } }))
  await run([process.execPath, 'install', '--ignore-scripts'], temp)
  if (await Bun.file(join(temp, 'node_modules/embedded-postgres/package.json')).exists()) throw new Error('Test database leaked into consumer runtime dependencies')
  await writeFile(join(temp, 'context.ts'), `
import {defineContext} from 'monoripper'
export default defineContext({create:({app})=>app.get('/status',()=>({pid:process.pid}))})
`)
  await writeFile(join(temp, 'smoke.ts'), `
import {strict as assert} from 'node:assert'
import {defineApp,monoripper,checkApp,connectControl} from 'monoripper'
const app=defineApp({project:'consumer',contexts:{api:{entry:'./context.ts',owns:[{method:'GET',path:'/status'}]}}})
assert.deepEqual(checkApp(app,{root:import.meta.dir}),[])
process.env.CONSUMER_CONTROL_TOKEN=crypto.randomUUID()+crypto.randomUUID()
const runtime=await monoripper.serve({app,root:import.meta.dir,initial:{api:{replicas:1}},http:{port:0},dataDir:'./state',control:{port:0,tokenEnv:'CONSUMER_CONTROL_TOKEN'}})
const client=await connectControl({address:runtime.controlAddress,token:process.env.CONSUMER_CONTROL_TOKEN,project:'consumer'})
try {
 const response=await fetch(new URL('/status',runtime.url))
 assert.equal(response.status,200)
 assert.notEqual((await response.json()).pid,process.pid)
 const operation=await client.setContext({context:'api',replicas:2,requestId:'package-scale',expectedRevision:(await client.getStatus()).revision})
 assert.equal((await client.waitOperation(operation.id)).phase,'succeeded')
 assert.equal((await client.getStatus()).contexts[0].readyReplicas,2)
} finally {client.close();await runtime.stop()}
console.log('PASS: installed npm archive starts its bundled worker outside the source checkout')
`)
  await run([process.execPath, 'smoke.ts'], temp)
  await run([join(temp, 'node_modules/.bin/monoripper'), '--help'], temp)
} finally { await rm(temp, { recursive: true, force: true }) }
