import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'plugin-cdn-refresh',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
