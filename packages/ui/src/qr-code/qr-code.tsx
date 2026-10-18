import encodeQR from 'qr'

export interface QrCodeProps {
  /** 要编码的文字，例如两步验证的 otpauth:// 地址 */
  value: string
  /** 读屏软件读出的名称，例如“两步验证的二维码” */
  label: string
}

/** 每个模块 4px：整数倍缩放，像素锐利（DESIGN.md §5） */
const SCALE = 4
/** 四周留 4 个模块的空白，这是规范要求的静区，扫码器靠它找到边缘 */
const QUIET_ZONE = 4

/** 把同一行里连续的深色模块合成一个矩形，路径短很多 */
function modulesPath(matrix: boolean[][]): string {
  let path = ''
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue
      let end = x
      while (row[end + 1]) end++
      path += `M${x} ${y}h${end - x + 1}v1h${x - end - 1}z`
      x = end
    }
  })
  return path
}

/**
 * 二维码，例如两步验证让验证器扫的那一个。在浏览器里生成，内容不经过任何外部服务。
 * 亮色和暗色主题下都是浅色底、深色模块：不少扫码器认不出反色的二维码。纯展示，可以在服务端渲染
 */
export function QrCode({ value, label }: QrCodeProps) {
  const matrix = encodeQR(value, 'raw', { ecc: 'medium', border: QUIET_ZONE })
  const size = matrix.length
  return (
    <svg
      role="img"
      aria-label={label}
      width={size * SCALE}
      height={size * SCALE}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="block rounded-sm border border-border"
    >
      <rect width={size} height={size} className="fill-text-inverse dark:fill-text" />
      <path d={modulesPath(matrix)} className="fill-text dark:fill-text-inverse" />
    </svg>
  )
}
