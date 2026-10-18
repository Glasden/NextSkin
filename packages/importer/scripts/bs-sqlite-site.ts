// 生成一个按 BS 表结构建的 SQLite 旧站：node packages/importer/scripts/bs-sqlite-site.ts <目录>
// 网页导入的 e2e 用它作旧库（apps/web/playwright.config.ts），手动检查安装向导时也可以用
import { resolve } from 'node:path'
import { createBsSqliteSite } from '../src/testing/sqlite-site.ts'

const directory = process.argv[2]
if (!directory) {
  console.error('用法：node packages/importer/scripts/bs-sqlite-site.ts <目录>')
  process.exit(2)
}
const site = await createBsSqliteSite(resolve(directory))
console.log(JSON.stringify(site))
