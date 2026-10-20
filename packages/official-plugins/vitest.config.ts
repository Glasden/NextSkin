import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'official-plugins', environment: 'node', include: ['src/**/*.test.ts'] },
})
