/**
 * 亮暗模式（DESIGN.md §10）：跟随系统，或者固定亮色、暗色。偏好按设备记在 Cookie 里，不进数据库；跟随系统时不写 Cookie。
 * <html> 上的 data-theme 只由内联脚本设置（亮色时也写），React 不管这个属性：否则从固定暗色改回跟随系统之后，
 * 一次 router.refresh 就会按服务端渲染的结果把它删掉
 */
export const colorModes = ['system', 'light', 'dark'] as const
export type ColorMode = (typeof colorModes)[number]

export const COLOR_MODE_COOKIE = 'nextskin-color-mode'

/** 改了偏好之后在 window 上派发：内联脚本据此重设 data-theme，页头的菜单据此更新选中项 */
export const COLOR_MODE_CHANGE = 'nextskin:color-mode'

export function parseColorMode(value: string | undefined): ColorMode {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** 从 document.cookie 那样的字符串里读出偏好 */
export function readColorMode(cookies: string): ColorMode {
  const prefix = `${COLOR_MODE_COOKIE}=`
  return parseColorMode(
    cookies
      .split('; ')
      .find((pair) => pair.startsWith(prefix))
      ?.slice(prefix.length),
  )
}

// 会被序列化成字符串、在浏览器里单独运行，所以自成一体：只用参数和浏览器的全局对象，不引用这个模块里的其他东西
function applyColorMode(cookie: string, event: string) {
  const query = matchMedia('(prefers-color-scheme: dark)')
  const apply = () => {
    const value = document.cookie
      .split('; ')
      .find((pair) => pair.startsWith(`${cookie}=`))
      ?.slice(cookie.length + 1)
    document.documentElement.dataset.theme =
      value === 'light' || value === 'dark' ? value : query.matches ? 'dark' : 'light'
  }
  apply()
  query.addEventListener('change', apply)
  addEventListener(event, apply)
}

/**
 * 根布局写进 <head> 的内联脚本：在第一次绘制之前设好 data-theme，不会先闪一下亮色；跟随系统时，系统切换亮暗也跟着变。
 * 以后上 CSP 时要给它 nonce 或者 hash（PROGRESS.md 的“站点的 CSP”）
 */
export const colorModeScript = `(${applyColorMode.toString()})(${JSON.stringify(COLOR_MODE_COOKIE)},${JSON.stringify(COLOR_MODE_CHANGE)})`
