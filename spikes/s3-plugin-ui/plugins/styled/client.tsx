/**
 * 用宿主 CSS 里没有的工具类（grid-cols-7、border-dashed、aspect-square……）和宿主没用到的 token（warning），
 * 验证插件自带的 Tailwind CSS 能用上宿主的 token，并随暗色模式切换。
 */
export default function Styled() {
  return (
    <div data-testid="styled-grid" className="grid grid-cols-7 gap-1 rounded-sm border-2 border-dashed border-warning bg-warning/20 p-2 dark:border-solid">
      {Array.from({ length: 14 }, (_, i) => (
        <span key={i} className="aspect-square bg-surface-sunken text-center text-xs text-text-muted">
          {i}
        </span>
      ))}
    </div>
  )
}
