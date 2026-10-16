import { defineContext } from '../../../src/index'
export default defineContext({ create() { throw new Error('PRIVATE_STARTUP_SECRET') } })
