import { defineContext } from '../../../src/index'
export default defineContext({ create: ({ app }) => app.onStart(() => { setTimeout(() => process.exit(17), 100) }).get('/flapping/pid', () => ({ pid: process.pid })) })
