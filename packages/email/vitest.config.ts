import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'email',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
