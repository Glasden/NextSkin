import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'plugin-authme-password',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
