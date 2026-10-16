import type { ESLint, Linter } from 'eslint'
import noNextPublicEnv from './rules/no-next-public-env.ts'
import noNextImage from './rules/no-next-image.ts'
import noSqliteDialect from './rules/no-sqlite-dialect.ts'
import noRawColor from './rules/no-raw-color.ts'
import noArbitraryValue from './rules/no-arbitrary-value.ts'
import noUseServer from './rules/no-use-server.ts'
import noModulepreload from './rules/no-modulepreload.ts'

const plugin = {
  meta: { name: '@nextskin/eslint-plugin' },
  rules: {
    'no-next-public-env': noNextPublicEnv,
    'no-next-image': noNextImage,
    'no-sqlite-dialect': noSqliteDialect,
    'no-raw-color': noRawColor,
    'no-arbitrary-value': noArbitraryValue,
    'no-use-server': noUseServer,
    'no-modulepreload': noModulepreload,
  },
  configs: {} as { recommended: Linter.Config },
} satisfies ESLint.Plugin

plugin.configs.recommended = {
  plugins: { nextskin: plugin },
  rules: Object.fromEntries(Object.keys(plugin.rules).map((name) => [`nextskin/${name}`, 'error' as const])),
}

export default plugin
