// 构建前运行（dev、build 和 turbo 的 typegen 任务）：从同一次检出的 packages/plugin-sdk/docs 生成插件 API 参考，记下页脚要显示的版本和提交（ADR-0054）；
// 按插槽的登记表和截图的清单生成"插槽一览"，两边对不上就失败（ADR-0060）。
// 生成的文件都在 .gitignore 里，不要手改。
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createTranslator } from '@nextskin/i18n'
import { pluginSlots } from '@nextskin/plugin-host/slots'

const root = new URL('../../../', import.meta.url)
const sdkDocs = new URL('packages/plugin-sdk/docs/', root)
const target = new URL('../src/content/docs/plugins/reference/', import.meta.url)
const versionsFile = new URL('../src/data/versions.json', import.meta.url)
// pnpm docs:screenshots 生成的截图和清单，提交在仓库里
const slotShots = new URL('../src/assets/slots/', import.meta.url)

// 侧栏顺序。新增文档时在这里补一行，缺省的排在最后。
const order = [
  'getting-started',
  'context',
  'routes',
  'ui',
  'slots',
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

  // 去掉 H1（标题进 frontmatter），把 ./x.md 与 ./x.md#锚点 改成站内路径。SDK 文档随 npm 包发布，
  // 链到只在文档站上的页面（插槽一览）时写完整地址，这里也改成站内路径。
  const body = markdown
    .replace(/^# .+\r?\n/, '')
    .replace(/\]\(\.\/([a-z0-9-]+)\.md(#[^)]*)?\)/g, '](/plugins/reference/$1/$2)')
    .replaceAll('](https://docs.nextskin.org/', '](/')

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

await writeFile(new URL('slots.mdx', target), await slotsPage())

await mkdir(new URL('.', versionsFile), { recursive: true })
await writeFile(versionsFile, `${JSON.stringify({ nextskin, sdk, commit }, null, 2)}\n`)

console.log(`已同步 ${files.length} 篇插件文档和插槽一览（plugin-sdk ${sdk}），NextSkin ${nextskin}`)

/** 插槽一览：序号、插槽、页面、谁看得到的表，每个页面桌面端和手机两张截图（ADR-0060） */
async function slotsPage(): Promise<string> {
  interface Shot {
    file: string
    width: number
  }
  interface ShotManifest {
    nextskin: string
    slots: { number: number; id: string; path: string }[]
    pages: { path: string; shots: { desktop: Shot; mobile: Shot } }[]
  }
  const slots = Object.entries(pluginSlots).map(([id, slot], index) => ({ number: index + 1, id, path: slot.path }))
  let manifest: ShotManifest | undefined
  try {
    manifest = JSON.parse(await readFile(new URL('slots.json', slotShots), 'utf8')) as ShotManifest
  } catch {
    manifest = undefined
  }
  const shotFiles = manifest?.pages.flatMap((page) => [page.shots.desktop.file, page.shots.mobile.file]) ?? []
  const present = new Set(await readdir(slotShots).catch(() => []))
  if (
    !manifest ||
    JSON.stringify(manifest.slots) !== JSON.stringify(slots) ||
    shotFiles.some((file) => !present.has(file))
  )
    throw new Error(
      '插槽的登记表（packages/plugin-host/src/slots.ts）和文档站的截图对不上：运行 pnpm docs:screenshots 重新生成（ADR-0060）',
    )

  const t = createTranslator('zh-CN')
  const place = (id: string) => t(`admin.plugins.slots.${id}` as Parameters<typeof t>[0])
  const audience = { user: '登录了、没被封禁的用户', admin: '管理员和超级管理员' }
  const image = (file: string) => file.replace(/\.png$/, '').replace(/-(.)/g, (_, c: string) => c.toUpperCase())
  const sections = manifest.pages.map(({ path, shots }) => {
    const onPage = slots.filter((slot) => slot.path === path)
    const name = onPage.map((slot) => place(slot.id)).join('、')
    const marks = onPage.map((slot) => `黑框 ${slot.number} 是插槽 ${slot.id}`).join('，')
    const legend = onPage.map((slot) => `黑框 ${slot.number} 是 \`${slot.id}\``).join('，')
    const tab = (label: string, shot: Shot, width?: number) =>
      [
        `  <TabItem label="${label}">`,
        `    <a href={${image(shot.file)}.src}>`,
        `      <Image src={${image(shot.file)}} ${width ? `width={${width}} ` : ''}alt="${name}的截图（${label}），${marks}" />`,
        '    </a>',
        '  </TabItem>',
      ].join('\n')
    return [
      `## ${name}`,
      '',
      `页面地址 \`${path}\`，${legend}。`,
      '',
      '<Tabs syncKey="slot-shots">',
      tab('桌面端', shots.desktop),
      tab('手机', shots.mobile, shots.mobile.width),
      '</Tabs>',
    ].join('\n')
  })

  return [
    '---',
    'title: "插槽一览"',
    `description: ${JSON.stringify(`插槽一览：NextSkin 插件开发文档，对应 @nextskin/plugin-sdk@${sdk}。`)}`,
    // 生成的页面，没有可以编辑的源文件
    'editUrl: false',
    'sidebar:',
    `  order: ${order.indexOf('slots') + 1}`,
    '---',
    '',
    "import { Image } from 'astro:assets'",
    "import { TabItem, Tabs } from '@astrojs/starlight/components'",
    ...shotFiles.map((file) => `import ${image(file)} from '../../../../assets/slots/${file}'`),
    '',
    '插槽是核心的页面上留给插件的位置。现在插槽里能放的是[挂件](/plugins/reference/ui/#挂件)：在 `ui.widgets` 里用 `slot` 指定放进哪个插槽。',
    '',
    '| 序号 | 插槽 | 页面 | 谁看得到 |',
    '| --- | --- | --- | --- |',
    ...slots.map(
      (slot) =>
        `| ${slot.number} | \`${slot.id}\` | ${place(slot.id)} | ${audience[pluginSlots[slot.id as keyof typeof pluginSlots].area]} |`,
    ),
    '',
    '截图里的挂件来自一个演示插件，它在每个插槽里放了两个（一个统计、一个 Markdown），黑框和序号标出插槽的范围。插槽里没有挂件时不占位置，页面和没装插件时一样。',
    '',
    `截图对应 NextSkin ${manifest.nextskin}，由 \`pnpm docs:screenshots\` 生成。`,
    '',
    ...sections.flatMap((section) => [section, '']),
  ].join('\n')
}
