import { open } from 'node:fs/promises'
import { defineResource } from 'monoripper'

export default defineResource({
  start: () => open(`/tmp/monoripper-resource-${process.pid}`, 'w+'),
  async stop(file) {
    await file.close()
    console.log(JSON.stringify({ event: 'resource-stopped', pid: process.pid }))
  },
})
