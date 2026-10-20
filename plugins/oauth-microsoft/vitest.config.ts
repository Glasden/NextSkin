import { defineProject } from 'vitest/config'
import { timeouts } from '../../vitest.shared.ts'

export default defineProject({
  test: {
    name: 'plugin-oauth-microsoft',
    ...timeouts,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
