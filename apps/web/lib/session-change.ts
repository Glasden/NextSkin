/**
 * 有管理权限的用户的会话不和跑过页头代码的文档共存（ADR-0063）。Cookie 是整个浏览器共用的：
 * 访客的标签页里跑着页头代码，在别的标签页登录以后，旧标签页的脚本带着新的会话。
 *
 * 登录时、有管理权限的用户打开页面时，往 localStorage 写下当前时间；跑着页头代码的文档在页头代码之前装好监听，
 * 别的标签页写了就整页重新加载。storage 事件不发给写入的那个文档，登录页不会把自己刷新掉。
 * 存储被禁用时只是少了这一层，登录本身的整页跳转照旧
 */
const SESSION_CHANGED_KEY = 'nextskin:session-changed'

export function announceSessionChange(): void {
  try {
    localStorage.setItem(SESSION_CHANGED_KEY, String(Date.now()))
  } catch {
    // 无痕模式的配额、站点数据被禁用
  }
}

// 会被序列化成字符串、在浏览器里单独运行，所以自成一体：只用参数和浏览器的全局对象，不引用这个模块里的其他东西
function reloadOnSessionChange(key: string) {
  try {
    // 本文档开始加载以后有人登录过：请求可能是在登录之前发出的，页头代码是按旧身份渲染的。
    // 晚于现在的时间不算：系统时钟往回调过，不然在追上之前每次打开都重新加载
    const changed = Number(localStorage.getItem(key))
    if (changed > performance.timeOrigin && changed <= Date.now()) location.reload()
    addEventListener('storage', (event) => {
      if (event.key === key) location.reload()
    })
  } catch {
    // 同上
  }
}

/** 放在页头代码前面的内联脚本，按 HTML 的解析顺序先于站长的脚本运行 */
export const sessionChangeScript = `(${reloadOnSessionChange.toString()})(${JSON.stringify(SESSION_CHANGED_KEY)})`
