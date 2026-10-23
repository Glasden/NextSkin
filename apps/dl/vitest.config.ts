import { defineProject } from 'vitest/config'
import { timeouts } from '../../vitest.shared.ts'

export default defineProject({
  test: {
    name: 'dl',
    ...timeouts,
    environment: 'node',
    include: ['*.test.ts'],
  },
})
