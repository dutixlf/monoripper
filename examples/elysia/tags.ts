import type { SQL } from 'bun'
import { defineContext } from '../../src/index'
import { tagsRouter } from './routes'

export default defineContext({
  create: ({ app, resources }) => app.use(tagsRouter(resources.get<SQL>('database'))),
})
