import { defineProject } from 'vitest/config'
import { timeouts } from '../../vitest.shared.ts'

export default defineProject({
  test: {
    name: 'i18n',
    ...timeouts,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
