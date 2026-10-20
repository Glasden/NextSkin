import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'launcher', environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 10_000 },
})
