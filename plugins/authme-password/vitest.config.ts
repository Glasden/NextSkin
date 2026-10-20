import { defineProject } from 'vitest/config'
import { timeouts } from '../../vitest.shared.ts'

export default defineProject({
  test: {
    name: 'plugin-authme-password',
    ...timeouts,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
