import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'skin',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
