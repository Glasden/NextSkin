import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'db', environment: 'node', include: ['src/**/*.test.ts'], env: { NEXTSKIN_TEST_DB: 'sqlite' } },
})
