import type { ESLint, Linter } from 'eslint'
import noNextPublicEnv from './rules/no-next-public-env.ts'
import noNextImage from './rules/no-next-image.ts'
import noSqliteDialect from './rules/no-sqlite-dialect.ts'
import noDialectSpecificSql from './rules/no-dialect-specific-sql.ts'
import noDirectScoreWrite from './rules/no-direct-score-write.ts'
import noRawColor from './rules/no-raw-color.ts'
import noArbitraryValue from './rules/no-arbitrary-value.ts'
import noHandRolledPanel from './rules/no-hand-rolled-panel.ts'
import noUseServer from './rules/no-use-server.ts'
import noModulepreload from './rules/no-modulepreload.ts'
import noScriptWithoutNonce from './rules/no-script-without-nonce.ts'

const plugin = {
  meta: { name: '@nextskin/eslint-plugin' },
  rules: {
    'no-next-public-env': noNextPublicEnv,
    'no-next-image': noNextImage,
    'no-sqlite-dialect': noSqliteDialect,
    'no-dialect-specific-sql': noDialectSpecificSql,
    'no-direct-score-write': noDirectScoreWrite,
    'no-raw-color': noRawColor,
    'no-arbitrary-value': noArbitraryValue,
    'no-hand-rolled-panel': noHandRolledPanel,
    'no-use-server': noUseServer,
    'no-modulepreload': noModulepreload,
    'no-script-without-nonce': noScriptWithoutNonce,
  },
  configs: {} as { recommended: Linter.Config },
} satisfies ESLint.Plugin

plugin.configs.recommended = {
  plugins: { nextskin: plugin },
  rules: Object.fromEntries(Object.keys(plugin.rules).map((name) => [`nextskin/${name}`, 'error' as const])),
}

export default plugin
