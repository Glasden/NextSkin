// 构建前运行：从同一次检出的 packages/plugin-sdk/docs 生成插件 API 参考，记下页脚要显示的版本和提交（ADR-0054）。
// 生成的文件都在 .gitignore 里，不要手改。
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'

const root = new URL('../../../', import.meta.url)
const sdkDocs = new URL('packages/plugin-sdk/docs/', root)
const target = new URL('../src/content/docs/plugins/reference/', import.meta.url)
const versionsFile = new URL('../src/data/versions.json', import.meta.url)

// 侧栏顺序。新增文档时在这里补一行，缺省的排在最后。
const order = [
  'getting-started',
  'context',
  'routes',
  'ui',
  'settings',
  'tables',
  'events',
  'jobs',
  'interceptors',
  'providers',
  'security',
  'versioning',
  'migrating-from-bs',
]

// 只有内容相对上一版有变化的文档才在侧栏标题旁标版本，避免每篇都挂一个徽章。
// 例：'context': 'v1.1.0'；留空表示都不标，版本号只出现在分组的徽章上。
const changedIn: Record<string, string> = {}

const readVersion = async (path: string) =>
  (JSON.parse(await readFile(new URL(path, root), 'utf8')) as { version: string }).version

const sdk = await readVersion('packages/plugin-sdk/package.json')
const nextskin = await readVersion('packages/launcher/package.json')

let commit: string | undefined
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch {
  // 不在 git 检出里构建（比如解压的源码包），页脚就不显示提交
}

const files = (await readdir(sdkDocs)).filter((file) => file.endsWith('.md')).sort()
if (files.length === 0) {
  throw new Error('packages/plugin-sdk/docs 里没有文档')
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })

for (const file of files) {
  const slug = file.replace(/\.md$/, '')
  const markdown = await readFile(new URL(file, sdkDocs), 'utf8')
  const title = /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? slug
  const badge = changedIn[slug]

  // 去掉 H1（标题进 frontmatter），把 ./x.md 与 ./x.md#锚点 改成站内路径。
  const body = markdown
    .replace(/^# .+\r?\n/, '')
    .replace(/\]\(\.\/([a-z0-9-]+)\.md(#[^)]*)?\)/g, '](/plugins/reference/$1/$2)')

  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(`${title}：NextSkin 插件开发文档，对应 @nextskin/plugin-sdk@${sdk}。`)}`,
    `editUrl: ${JSON.stringify(`https://github.com/Glasden/NextSkin/edit/main/packages/plugin-sdk/docs/${file}`)}`,
    'sidebar:',
    `  order: ${order.indexOf(slug) + 1 || 99}`,
    ...(badge ? ['  badge:', `    text: ${badge}`, '    variant: note'] : []),
    '---',
    '',
  ]

  await writeFile(new URL(`${slug}.md`, target), [...frontmatter, body].join('\n'))
}

await mkdir(new URL('.', versionsFile), { recursive: true })
await writeFile(versionsFile, `${JSON.stringify({ nextskin, sdk, commit }, null, 2)}\n`)

console.log(`已同步 ${files.length} 篇插件文档（plugin-sdk ${sdk}），NextSkin ${nextskin}`)
