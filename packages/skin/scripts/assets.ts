/**
 * 把随核心发布的材质（assets/）渲染成插图用的正面 3D 出图和抬手拼图，写进 assets/figures/。网页把它们当静态文件引用（登录页插图），
 * 材质的出图路由落地后改走路由。渲染器升级（RENDERER_VERSION 变了）后运行，否则 src/assets.test.ts 会失败
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { RENDERER_VERSION } from '../src/index.ts'
import { assetFigureDirectory, assetFigures, encodePng, type AssetFigureManifest } from '../test/cases.ts'

rmSync(assetFigureDirectory, { recursive: true, force: true })
mkdirSync(assetFigureDirectory, { recursive: true })
const manifest: AssetFigureManifest = { rendererVersion: RENDERER_VERSION, figures: {} }
for (const { name, type, textureScale, files } of assetFigures()) {
  for (const { file, render } of files) writeFileSync(new URL(file, assetFigureDirectory), encodePng(render()))
  manifest.figures[name] = { type, textureScale }
}
writeFileSync(new URL('manifest.json', assetFigureDirectory), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`${Object.keys(manifest.figures).length} 张材质，渲染器版本 ${RENDERER_VERSION}`)
