// 构建前运行（dev、build 和 turbo 的 typegen 任务）：用仓库的代码算出画面上的数据和出图（ADR-0055）。
// 生成的文件都在 .gitignore 里，不要手改：
// - src/gen/repo-data.json：hash、PNG 的块、插件查询、契约用例、ADR 份数、迁移数、一键升级的版本号
// - public/gen/：展示皮肤和出图
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// 一键升级那一页：升到这次构建的版本。CI 的检出不带标签，从哪个版本升上来按版本号推：上一个次版本的 .0，
// x.0.y 是 x.0.0。正式版只在标签上部署，x.0.0 那一次画不出来，到时候再定
const { version } = JSON.parse(readFileSync(join(repo, 'packages/launcher/package.json'), 'utf8')) as {
  version: string
}
const [major, minor, patch] = (/^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number)
if (major === undefined || minor === undefined || patch === undefined || minor + patch === 0)
  throw new Error(`推不出 ${version} 的上一个版本，改一下 generate.ts 里的规则`)
const upgrade = { from: minor > 0 ? `${major}.${minor - 1}.0` : `${major}.0.0`, to: version }

const data = {
  ...(await generateFigures(join(pub, 'pose'))),
  ...generateQueries(),
  adrs,
  migrations,
  upgrade,
  contractCases: cases.length,
  contractScenarios: scenarios.length,
  contractTitles: [...cases.map((c) => c.title), ...scenarios.map((s) => s.title)],
}

mkdirSync(join(site, 'src/gen'), { recursive: true })
writeFileSync(join(site, 'src/gen/repo-data.json'), `${JSON.stringify(data, null, 2)}\n`)
