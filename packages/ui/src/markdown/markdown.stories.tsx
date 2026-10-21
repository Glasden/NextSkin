import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
// 不内联：小图在构建时会变成 data: 地址，Markdown 不放行
import badge from './fixtures/badge.png?url&no-inline'
import { Markdown } from './markdown.tsx'

const meta = {
  title: 'Components/Markdown',
  component: Markdown,
  args: { children: '' },
  decorators: [
    (Story) => (
      <div className="w-140 max-w-full rounded-md border border-border bg-surface p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>

export default meta
type Story = StoryObj<typeof meta>

const announcement = `# 欢迎来到像素工坊

本站提供皮肤托管和外置登录，**完全免费**。第一次来，先看看下面几步：

1. 在用户中心添加一个角色，名字就是你在游戏里的玩家名；
2. 去[皮肤库](/skinlib)挑一个皮肤，或者上传自己画的；
3. 在启动器里选择外置登录，填写本站地址。

## 服务器

- 生存服：\`play.example.test\`，每周六晚上重启
- 创造服：~~暂停开放~~ 已恢复

有问题请在 QQ 群里找管理员，或者发邮件到 [admin@example.test](mailto:admin@example.test)。`

export const Announcement: Story = {
  args: { children: announcement },
  play: async ({ canvas }) => {
    // 公告放在“公告”区块（h2）下面，# 渲染成 h3
    await expect(canvas.getByRole('heading', { level: 3, name: '欢迎来到像素工坊' })).toBeVisible()
    await expect(canvas.getByRole('heading', { level: 4, name: '服务器' })).toBeVisible()
    await expect(canvas.getByRole('link', { name: '皮肤库' })).toHaveAttribute('href', '/skinlib')
  },
}

export const Elements: Story = {
  args: {
    children: `### 三级标题

> 引用的文字，
> 可以有好几行。

- [x] 已经完成的事项
- [ ] 还没有完成的事项

| 项目 | 积分 | 说明 |
| :-- | --: | :-: |
| 添加角色 | 100 | 删除时退还 |
| 上传公开材质 | 1 / KB | 按文件大小 |

\`\`\`json
{ "skinDomains": [".example.test"], "signaturePublickey": "-----BEGIN PUBLIC KEY-----" }
\`\`\`

---

一个很长的地址也会在容器里换行：https://example.test/a/very/long/path/that/keeps/going/and/going/without/any/spaces`,
  },
}

export const UnsafeContent: Story = {
  args: {
    children: `正文里的 <b>标签</b> 和下面的块都会被去掉。

<script>alert(1)</script>

<div onclick="alert(1)">点我</div>

[危险链接](javascript:alert(1)) [数据链接](data:text/html,x) [普通链接](https://example.test)

![图片](javascript:alert(1))`,
  },
  play: async ({ canvasElement, canvas }) => {
    await expect(canvasElement.querySelector('script, b, div[onclick], img')).toBeNull()
    await expect(canvas.queryByText('点我')).toBeNull()
    // 不安全的地址被清空，留下没有 href 的文字
    for (const name of ['危险链接', '数据链接']) await expect(canvas.getByText(name)).not.toHaveAttribute('href')
    await expect(canvas.getByRole('link', { name: '普通链接' })).toHaveAttribute('href', 'https://example.test')
  },
}

/** 页脚：图片缩到一行字的高度，例如公安备案号前面的图标；图片是 story 用的示意图 */
export const InlineImages: Story = {
  args: {
    inlineImages: true,
    children: `[京ICP备00000000号-1](https://beian.miit.gov.cn/) · ![](${badge}) [京公网安备 11010800000000 号](https://beian.mps.gov.cn/)`,
  },
  decorators: [
    (Story) => (
      <div className="text-sm text-text-muted">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const image = canvasElement.querySelector('img')!
    await expect(image.getBoundingClientRect().height).toBe(20)
    await expect(image.closest('p')!.getBoundingClientRect().height).toBe(20)
  },
}
