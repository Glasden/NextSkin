// 构建前运行（dev、build 和 turbo 的 typegen 任务）：用仓库的代码算出画面上的数据和出图（ADR-0055）。
// 生成的文件都在 .gitignore 里，不要手改：
// - src/gen/repo-data.json：hash、PNG 的块、插件查询、契约用例、ADR 份数、迁移数
// - public/gen/：展示皮肤和出图
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cases, scenarios } from '../../../tests/contract/src/cases.ts'
import { generateFigures } from './figures.ts'
import { generateQueries } from './queries.ts'

const site = join(import.meta.dirname, '..')
const repo = join(site, '../..')
const pub = join(site, 'public/gen')

rmSync(pub, { recursive: true, force: true })
mkdirSync(join(pub, 'skin'), { recursive: true })
// 唯一的展示材质：cxchency 的皮肤（packages/skin/assets/README.md），纤细模型，64×64
copyFileSync(join(repo, 'packages/skin/assets/default-skin.png'), join(pub, 'skin/default-skin.png'))

const adrs = readdirSync(join(repo, 'docs/adr')).filter((f) => /^\d{4}-.*\.md$/.test(f)).length
const migrations = readdirSync(join(repo, 'packages/db/src/migrations')).filter(
  (f) => /^\d+.*\.ts$/.test(f) && !f.includes('.test.'),
).length

const data = {
  ...(await generateFigures(join(pub, 'pose'))),
  ...generateQueries(),
  adrs,
  migrations,
  contractCases: cases.length,
  contractScenarios: scenarios.length,
  contractTitles: [...cases.map((c) => c.title), ...scenarios.map((s) => s.title)],
}

mkdirSync(join(site, 'src/gen'), { recursive: true })
writeFileSync(join(site, 'src/gen/repo-data.json'), `${JSON.stringify(data, null, 2)}\n`)
