# packages/skin

材质的前处理和 2D 渲染（ADR-0017）。服务端的图像 worker 用它出图，浏览器的上传页也用它，所以 `src/` 里只能写标准 JS：不用 `node:` 模块、`Buffer`、`process`（lint 守着）。PNG 的编解码不在这里。

- 任何输出像素变了，都要把 `RENDERER_VERSION` 加 1，再运行 `pnpm --filter @nextskin/skin golden` 和 `pnpm --filter @nextskin/ui skin:fixtures`。版本号在出图地址里，不升的话浏览器和 CDN 会一直用旧图。不升版本号时，黄金图测试会失败，生成脚本也拒绝写入。
- 规则以 S4（`spikes/s4-image-pipeline/src/render.ts`）为准，合成的算术（float32 和截断的顺序）也要一致。
- 热循环按无分配的方式写：类型化数组，不在循环里创建对象、不用 `subarray`。
- 浏览器里给这个包喂像素时，不要用 canvas 的 `getImageData` 解码 PNG：画布按预乘 alpha 存像素，完全透明的像素会丢掉原来的 RGB，半透明像素有舍入误差，还可能被转换颜色空间。游戏会把基础层的透明像素显示成不透明，这些 RGB 看得见。要用 JS 写的 PNG 解码器。
