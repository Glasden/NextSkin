// @ts-check
import js from '@eslint/js'
import nextPlugin from '@next/eslint-plugin-next'
import nextskin from '@nextskin/eslint-plugin'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// 各包的 lint 任务（`eslint .`）都用这一份配置；按目录的差异写在下面的 files 段里。
export default defineConfig(
  globalIgnores(['**/dist/', '**/.next/', '**/.astro/', '**/storybook-static/', '**/next-env.d.ts', 'spikes/']),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['packages/skin/src/**/*.ts'],
    ignores: ['packages/skin/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['node:*'], message: '这个包要在浏览器里运行（ADR-0017）' }],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: '这个包要在浏览器里运行（ADR-0017）' },
        { name: 'process', message: '这个包要在浏览器里运行（ADR-0017）' },
      ],
    },
  },

  {
    files: ['packages/domain/src/**/*.ts', 'packages/api/src/**/*.ts', 'packages/db/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.db.test.ts', '**/*.test-helper.ts'],
    rules: { 'no-console': 'error' },
  },

  // 不变量写成的规则（packages/eslint-plugin）
  nextskin.configs.recommended,
  {
    files: [
      // adjustScore 自身负责在同一事务里更新积分并写流水。
      'packages/domain/src/score/adjust.ts',
      // 导入器原样写入旧积分，并另写一条「导入」流水（docs/schema.md）。
      'packages/importer/**',
      // 迁移和数据库测试需要直接操作底层数据。
      'packages/db/**',
      // 测试直接构造积分数据。
      '**/*.test.ts',
    ],
    rules: { 'nextskin/no-direct-score-write': 'off' },
  },
  {
    // token 和组件在这里定义，可以写原始色值和任意值
    files: ['packages/ui/**'],
    rules: { 'nextskin/no-raw-color': 'off', 'nextskin/no-arbitrary-value': 'off' },
  },
  {
    // 面板和卡片在 packages/ui 里定义；宣传站的画面是从介绍视频分叉的仿制界面，不用 Panel（ADR-0055）
    files: ['packages/ui/**', 'apps/site/**'],
    rules: { 'nextskin/no-hand-rolled-panel': 'off' },
  },
  {
    // 邮件客户端不支持 CSS 变量，颜色只能写成具体的值；取值和 theme.css 一致由 packages/email 的 tokens.test.ts 守护
    files: ['packages/email/**'],
    rules: { 'nextskin/no-raw-color': 'off' },
  },
  {
    // 配色主题以色值为数据：钻石青由 design:sync 从 theme.css 生成，插件的主题由核心检查对比度后生成 CSS（ADR-0057）
    files: ['packages/theme/**', 'plugins/color-themes/**'],
    rules: { 'nextskin/no-raw-color': 'off' },
  },
  {
    // SQLite 方言和跨数据库 SQL 辅助函数就在这里实现，需要使用底层方言 API
    files: ['packages/db/**'],
    rules: { 'nextskin/no-sqlite-dialect': 'off', 'nextskin/no-dialect-specific-sql': 'off' },
  },
  {
    // 核心迁移只能通过辅助函数处理方言差异（ADR-0005、ADR-0015），所以重新打开
    files: ['packages/db/src/migrations/**'],
    rules: { 'nextskin/no-dialect-specific-sql': 'error' },
  },
  {
    // 规则自己的测试用例里全是反例
    files: ['packages/eslint-plugin/src/**/*.test.ts'],
    rules: Object.fromEntries(Object.keys(nextskin.rules).map((name) => [`nextskin/${name}`, 'off'])),
  },

  {
    // 插件提供的函数按 API 要求一律返回 Promise（可能跨进程调用），未必有 await
    files: [
      'packages/plugin-sdk/type-tests/**',
      'packages/plugin-cli/fixtures/**',
      'plugins/**',
      'apps/docs/screenshots/demo-plugin/**',
    ],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // 插件拿到的 Kysely 不直连数据库：核心网关按白名单重建操作树、再用自己的方言编译（ADR-0010），
    // 跨数据库的差异在网关里处理；插件也用不到 packages/db 的辅助函数
    files: ['packages/plugin-sdk/**', 'packages/plugin-cli/fixtures/**', 'plugins/**'],
    rules: { 'nextskin/no-dialect-specific-sql': 'off' },
  },
  {
    // 类型契约测试：裸表达式用来挂 @ts-expect-error
    files: ['packages/plugin-sdk/type-tests/**'],
    rules: { '@typescript-eslint/no-unused-expressions': 'off' },
  },

  {
    files: ['apps/web/**', 'packages/ui/**'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  {
    files: ['apps/web/**'],
    extends: [nextPlugin.configs['core-web-vitals']],
    rules: {
      // 只用 App Router，没有 pages 目录
      '@next/next/no-html-link-for-pages': 'off',
      // 材质用普通 img 加 image-rendering: pixelated，不经过 next/image（不变量 8）
      '@next/next/no-img-element': 'off',
    },
  },
  {
    files: ['apps/web/e2e/**'],
    ignores: ['apps/web/e2e/fixtures.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@playwright/test',
              importNames: ['test', 'expect'],
              message: '从 ./fixtures 导入：它在页面出现 CSP 违规时让用例失败（ADR-0053）',
            },
          ],
        },
      ],
    },
  },
)
