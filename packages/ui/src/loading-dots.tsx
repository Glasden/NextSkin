/** 三个方块依次亮起；减少动态效果时静止。按钮的提交中、验证码挂件的加载中共用（DESIGN.md §7） */
export function LoadingDots() {
  return (
    <span aria-hidden className="inline-flex items-center gap-1">
      {['0ms', '-600ms', '-300ms'].map((delay) => (
        <span
          key={delay}
          className="size-1 bg-current animate-loading motion-reduce:animate-none"
          style={{ animationDelay: delay }}
        />
      ))}
    </span>
  )
}
