// S4 over：归一化和中间结果的 float32 舍入、最终截断顺序均不可改变。
// 直接传数组和偏移，热循环不分配颜色元组或 subarray。
export function over(dst: Uint8Array, p: number, src: Uint8Array, q: number): void {
  const f = Math.fround
  const a = f(src[q + 3]! / 255)
  if (!a) return
  const b = f(dst[p + 3]! / 255)
  const t = f(1 - a)
  const oa = f(a + f(b * t))
  for (let c = 0; c < 3; c++) {
    const source = f(f(src[q + c]! / 255) * a)
    const dest = f(f(dst[p + c]! / 255) * b)
    dst[p + c] = Math.max(0, Math.min(255, Math.trunc(f(f(f(source + t * dest) / oa) * 255))))
  }
  dst[p + 3] = Math.trunc(f(oa * 255))
}
