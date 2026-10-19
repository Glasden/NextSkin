import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'plugin-oauth-google',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
