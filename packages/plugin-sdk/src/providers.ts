import type { IconName, MessageKey } from './ui.ts'

/**
 * Provider：插件实现核心定义好的接口，由核心在合适的时机调用。
 *
 * 所有方法都是异步的：插件可能在另一个进程里。
 */
export interface Providers<Ctx> {
  readonly passwordHasher?: readonly PasswordHasherProvider<Ctx>[]
  readonly login?: readonly LoginProvider<Ctx>[]
}

/**
 * 校验外部系统格式的密码哈希（AuthMe、Discuz 等）。网页登录、启动器登录和敏感操作前的核对密码都经过它。
 *
 * 只需要校验，不需要生成：网页登录和启动器登录校验成功后，核心会立刻用自己的算法重新哈希并替换，
 * 所以每个用户通常只经过一次插件校验。明文密码会交给插件，安装时按高风险展示。
 *
 * - 只有既不是核心当前的算法、也不是 BS 旧格式（bcrypt、argon2、BS 的摘要）的哈希才会交给插件，
 *   并且要先匹配上 `detect`。哈希里要带齐校验需要的全部信息（盐、算法参数）。
 * - 多个 Provider 匹配上同一个哈希时，按插件 id、再按声明顺序依次调用，有一个返回 true 就通过。
 * - 每次调用 5 秒内要完成。超时、抛错、返回值不是布尔值，都按密码不对处理；连续失败的 Provider
 *   在冷却期内不再调用。
 * - BS 网页登录时会去掉密码首尾的空白：按原样不通过、首尾又有空白时，核心会再用去掉空白的密码调用一次。
 * - 密码不要写进日志，也不要放进错误消息：没被 await 的 Promise 失败时，错误消息会记进站点的日志。
 */
export interface PasswordHasherProvider<Ctx> {
  readonly id: string
  readonly label: MessageKey
  /** 声明式识别规则，由核心在本进程内匹配，不发生跨进程调用。两项都写时，满足任一项就算匹配。 */
  readonly detect: {
    /** 哈希的开头，区分大小写 */
    readonly prefix?: readonly string[]
    /** 正则表达式源码，按 `u` 标志编译，在核心进程里执行：要写成不会回溯爆炸的表达式 */
    readonly pattern?: string
  }
  verify(args: { password: string; hash: string; ctx: Ctx }): Promise<boolean>
}

/**
 * 第三方登录（GitHub、Microsoft、QQ……）。
 * state、PKCE、账号绑定、会话创建都由核心处理，插件只负责和第三方交换身份。
 * 首次登录建号同样经过 `user.register` 拦截器和注册表单的插件字段。
 */
export interface LoginProvider<Ctx> {
  readonly id: string
  readonly label: MessageKey
  readonly icon: IconName
  authorizeUrl(args: { state: string; codeChallenge: string; redirectUri: string; ctx: Ctx }): Promise<string>
  exchange(args: {
    /** 回调 URL 上的全部查询参数 */
    query: Readonly<Record<string, string>>
    codeVerifier: string
    redirectUri: string
    ctx: Ctx
  }): Promise<ExternalIdentity>
}

export interface ExternalIdentity {
  /** 第三方系统内稳定不变的用户标识 */
  readonly subject: string
  readonly email: string | null
  readonly emailVerified: boolean
  readonly displayName: string | null
  readonly avatarUrl: string | null
}
