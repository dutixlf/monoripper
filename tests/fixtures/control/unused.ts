import { defineContext } from '../../../src/index'
export default defineContext({ create: ({ app }) => app.get('/unused/pid', () => ({ pid: process.pid })) })
