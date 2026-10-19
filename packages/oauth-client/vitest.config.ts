import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'oauth-client',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
