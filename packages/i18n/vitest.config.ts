import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'i18n',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
