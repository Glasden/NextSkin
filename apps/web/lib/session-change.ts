/**
 * 有管理权限的用户的会话不和跑过页头代码的文档共存（ADR-0063）。Cookie 是整个浏览器共用的：
 * 访客的标签页里跑着页头代码，在别的标签页登录以后，旧标签页的脚本带着新的会话。
 *
 * 登录时、有管理权限的用户打开页面时，往 localStorage 写一下；跑着页头代码的文档在页头代码之前装好监听，
 * 别的标签页写了就整页重新加载。storage 事件不发给写入的那个文档，登录页不会把自己刷新掉。
 * 写的值只是为了每次都不一样（值没变不触发 storage 事件），不拿来和时间比：performance.timeOrigin 和 Date.now()
 * 不一定在同一条时间线上，系统时间调过以后会一直重新加载。
 * 存储被禁用时只是少了这一层，登录本身的整页跳转照旧
 */
const SESSION_CHANGED_KEY = 'nextskin:session-changed'

export function announceSessionChange(): void {
  try {
    localStorage.setItem(SESSION_CHANGED_KEY, `${Date.now()}-${Math.random()}`)
  } catch {
    // 无痕模式的配额、站点数据被禁用
  }
}

// 会被序列化成字符串、在浏览器里单独运行，所以自成一体：只用参数和浏览器的全局对象，不引用这个模块里的其他东西
function reloadOnSessionChange(key: string) {
  addEventListener('storage', (event) => {
    if (event.key === key) location.reload()
  })
}

/** 放在页头代码前面的内联脚本 */
export const sessionChangeScript = `(${reloadOnSessionChange.toString()})(${JSON.stringify(SESSION_CHANGED_KEY)})`
