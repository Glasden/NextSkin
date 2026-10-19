import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'plugin-oauth-littleskin',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
