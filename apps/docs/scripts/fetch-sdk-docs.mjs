import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const project = join(here, '..')

const repo = process.env.NEXTSKIN_REPO ?? 'Glasden/NextSkin'
const ref = process.env.NEXTSKIN_REF ?? 'main'
const target = join(project, 'src/content/docs/plugins/reference')
const metaFile = join(project, 'src/data/sdk-meta.json')

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
const changedIn = {}

const work = await mkdtemp(join(tmpdir(), 'nextskin-docs-'))

try {
  const url = `https://codeload.github.com/${repo}/tar.gz/${ref}`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`下载 ${url} 失败：HTTP ${response.status}`)
  }

  const archive = join(work, 'source.tgz')
  await writeFile(archive, Buffer.from(await response.arrayBuffer()))

  const source = join(work, 'source')
  await mkdir(source)
  await run('tar', ['-xzf', archive, '--strip-components=1', '-C', source])

  const sdk = join(source, 'packages/plugin-sdk')
  const pkg = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'))
  const docs = join(sdk, 'docs')
  const files = (await readdir(docs)).filter((file) => file.endsWith('.md')).sort()

  if (files.length === 0) {
    throw new Error(`${repo}@${ref} 的 packages/plugin-sdk/docs 为空`)
  }

  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await mkdir(dirname(metaFile), { recursive: true })
  await writeFile(metaFile, `${JSON.stringify({ version: pkg.version, repo, ref }, null, 2)}\n`)

  for (const file of files) {
    const slug = file.replace(/\.md$/, '')
    const markdown = await readFile(join(docs, file), 'utf8')
    const title = markdown.match(/^# (.+)$/m)?.[1]?.trim() ?? slug
    const version = changedIn[slug]

    // 去掉 H1（标题进 frontmatter），把 ./x.md 与 ./x.md#锚点 改成站内路径。
    const body = markdown
      .replace(/^# .+\r?\n/, '')
      .replace(/\]\(\.\/([a-z0-9-]+)\.md(#[^)]*)?\)/g, '](/plugins/reference/$1/$2)')

    const frontmatter = [
      '---',
      `title: ${JSON.stringify(title)}`,
      `description: ${JSON.stringify(`${title}：NextSkin 插件开发文档，对应 @nextskin/plugin-sdk@${pkg.version}。`)}`,
      `editUrl: ${JSON.stringify(`https://github.com/${repo}/edit/main/packages/plugin-sdk/docs/${file}`)}`,
      'sidebar:',
      `  order: ${order.indexOf(slug) + 1 || 99}`,
    ]

    if (version) {
      frontmatter.push('  badge:', `    text: ${version}`, '    variant: note')
    }

    frontmatter.push('---', '')

    const page = [...frontmatter, body].join('\n')
    await writeFile(join(target, `${slug}.md`), page)
  }

  console.log(`已同步 ${files.length} 篇插件文档：${repo}@${ref}（plugin-sdk ${pkg.version}）`)
} finally {
  await rm(work, { recursive: true, force: true })
}
