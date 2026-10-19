import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'plugin-oauth-github',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
