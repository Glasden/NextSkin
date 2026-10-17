import { pathToFileURL } from 'node:url'
import { download } from '../scripts/download.ts'

// 截图容器（官方 Playwright 镜像）里的中文字体只有文泉驿正黑，它带点阵字形，渲染效果和用户看到的差得远。
// 下载 Noto Sans CJK SC 的两个字重，由 playwright.config.ts 挂进容器：正文字体栈（DESIGN.md §4）在 Linux 上会选中它。
// 用法：node visual/fonts.ts <目录>
const base =
  'https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/OTF/SimplifiedChinese/'
const fonts = {
  'NotoSansCJKsc-Regular.otf': '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
  'NotoSansCJKsc-Medium.otf': 'ca094f6b0001fb048ca39ddd797a0cdb0179e1e55c6561e111c49c3e6a61d7b7',
}

const dir = process.argv[2]
if (!dir) throw new Error('用法：node visual/fonts.ts <目录>')
for (const [file, sha256] of Object.entries(fonts)) {
  await download({ url: base + file, sha256 }, new URL(file, pathToFileURL(`${dir}/`)))
}
