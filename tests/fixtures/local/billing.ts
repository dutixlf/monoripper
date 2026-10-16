import { defineContext } from '../../../src/index'

await Bun.write(process.env.DISABLED_MARKER!, 'billing was imported')
export default defineContext({ create: ({ app }) => app.get('/api/billing', () => 'billing') })
