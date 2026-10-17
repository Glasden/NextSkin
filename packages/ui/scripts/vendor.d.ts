// 字体脚本用到的两个包没有自带类型，只声明用到的部分

declare module 'subset-font' {
  interface SubsetOptions {
    targetFormat?: 'sfnt' | 'truetype' | 'woff' | 'woff2'
    preserveNameIds?: number[]
  }
  export default function subsetFont(font: Uint8Array, text: string, options?: SubsetOptions): Promise<Buffer>
}

declare module 'wawoff2' {
  export function compress(sfnt: Uint8Array): Promise<Uint8Array>
  export function decompress(woff2: Uint8Array): Promise<Uint8Array>
}
