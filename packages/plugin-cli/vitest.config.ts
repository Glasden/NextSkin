import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'plugin-cli',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
