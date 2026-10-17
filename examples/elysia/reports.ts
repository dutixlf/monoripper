import { defineContext } from '../../src/index'

// The integration check sets this marker and proves disabled entries are not imported.
if (process.env.DISABLED_CONTEXT_MARKER) await Bun.write(process.env.DISABLED_CONTEXT_MARKER, 'imported')

export default defineContext({
  create: ({ app }) => app.get('/v1/reports', () => ({ pid: process.pid })),
})
