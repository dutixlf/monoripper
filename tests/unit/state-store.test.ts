import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StateStore } from '../../src/state-store'

const scope = { project: 'state-test', environment: 'development', contexts: ['user', 'billing'], initial: { user: 1, billing: 0 } }

test('native exclusive writer, immutable reads, serialized durable writes and recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-state-'))
  try {
    const first = await StateStore.open({ ...scope, directory })
    try {
      await expect(StateStore.open({ ...scope, directory })).rejects.toMatchObject({ code: 'STATE_LOCKED' })
      const copy = first.read()
      copy.desired.user = 42
      expect(first.read().desired.user).toBe(1)
      await Promise.all([first.update(s => { s.revision++; s.desired.user = 2 }), first.update(s => { s.revision++; s.desired.billing = 1 })])
      expect(first.read().revision).toBe(2)
      expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).desired).toEqual({ user: 2, billing: 1 })
    } finally { await first.close() }
    const recovered = await StateStore.open({ ...scope, initial: { user: 0, billing: 0 }, directory })
    try { expect(recovered.read().desired).toEqual({ user: 2, billing: 1 }) } finally { await recovered.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('corrupt state is not silently reset and the kernel lock is released after rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-corrupt-'))
  try {
    await writeFile(join(directory, 'state.json'), '{broken')
    await expect(StateStore.open({ ...scope, directory })).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(await readFile(join(directory, 'state.json'), 'utf8')).toBe('{broken')
    await rm(join(directory, 'state.json'))
    const store = await StateStore.open({ ...scope, directory })
    await store.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('invalid mutation cannot replace the last valid durable snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-invalid-state-'))
  const store = await StateStore.open({ ...scope, directory })
  try {
    await expect(store.update(s => { s.desired.user = -1 })).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(store.read().desired.user).toBe(1)
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }) }
})
