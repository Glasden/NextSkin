import type { Rule } from 'eslint'

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止绕过 packages/db 的 SQLite 方言' },
    schema: [],
    messages: {
      forbidden:
        'AGENTS.md 已知的坑：请通过 packages/db 的方言访问 SQLite。node:sqlite 会把第一个对象参数当成命名参数表，开头是 Date 或传入数组时后面的参数整体错位，而且不报错。',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value
        if (source === '@better-auth/kysely-adapter/node-sqlite-dialect') {
          context.report({ node, messageId: 'forbidden' })
          return
        }
        for (const specifier of node.specifiers) {
          const imported = specifier.type === 'ImportSpecifier' ? specifier.imported : null
          const name = imported?.type === 'Identifier' ? imported.name : imported?.value
          if (
            (source === 'kysely' && name === 'SqliteDialect') ||
            (typeof source === 'string' &&
              (source.startsWith('better-auth') || source.startsWith('@better-auth/')) &&
              (name === 'NodeSqliteDialect' || specifier.local.name === 'NodeSqliteDialect'))
          ) {
            context.report({ node: specifier, messageId: 'forbidden' })
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value === '@better-auth/kysely-adapter/node-sqlite-dialect') {
          context.report({ node, messageId: 'forbidden' })
        } else if (node.source?.value === 'kysely') {
          for (const specifier of node.specifiers) {
            const name = specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value
            if (name === 'SqliteDialect') context.report({ node: specifier, messageId: 'forbidden' })
          }
        }
      },
      ExportAllDeclaration(node) {
        if (node.source.value === '@better-auth/kysely-adapter/node-sqlite-dialect') {
          context.report({ node, messageId: 'forbidden' })
        }
      },
    }
  },
}

export default rule
