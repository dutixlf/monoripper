import { defineContext } from '../../src/index'

export default defineContext({
  create: ({ app }) => app.get('/api/user/status', () => ({ context: 'user', pid: process.pid })),
})
