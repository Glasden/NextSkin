import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'plugin-oauth-microsoft',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
