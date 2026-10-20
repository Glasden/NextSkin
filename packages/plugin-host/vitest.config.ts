import { defineProject } from 'vitest/config'
import { timeouts } from '../../vitest.shared.ts'

export default defineProject({
  test: {
    name: 'plugin-host',
    ...timeouts,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
