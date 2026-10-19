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
  /** `[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*`。 */
  readonly id: string
  readonly label: MessageKey
  /** 声明式识别规则，由核心在本进程内匹配，不发生跨进程调用。两项都写时，满足任一项就算匹配。 */
  readonly detect: (
    | { readonly prefix: readonly string[]; readonly pattern?: string }
    | { readonly prefix?: readonly string[]; readonly pattern: string }
  ) & {
    /** 哈希的开头，区分大小写 */
    readonly prefix?: readonly string[]
    /** 正则表达式源码，按 `u` 标志编译，在核心进程里执行：要写成不会回溯爆炸的表达式 */
    readonly pattern?: string
  }
  verify(args: { password: string; hash: string; ctx: Ctx }): Promise<boolean>
}

/**
 * 第三方登录（GitHub、Microsoft、QQ……）。一个第三方一个插件，插件一般只声明一个 Provider（ADR-0034）。
 *
 * state、PKCE、账号绑定、会话创建都由核心处理，插件只负责和第三方交换身份：
 * - 绑定按插件 id 和 Provider id 记录。插件只能给出自己名下的身份，冒认不了别的插件的用户；
 * - 首次登录先进"完成注册"页，再经过注册用例：`user.register` 拦截器和注册表单的插件字段照样生效；
 * - 第三方给的邮箱已经是别人的账号时，核心不会自动绑定（那个账号已经没有任何登录方式、`emailVerified` 为 true 时除外）。
 *
 * 插件被停用时按钮消失、绑定保留；插件被卸载时它名下的绑定一并删除。
 * 超时、抛错、返回值不合格都按这次登录失败处理；连续失败的 Provider 在冷却期内不再调用。
 * 日志和错误消息里不要写授权码、令牌和第三方返回的个人信息：核心只记失败的原因，不记插件抛出的消息。
 */
export interface LoginProvider<Ctx> {
  /**
   * 匹配 `[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*`，不超过 64 个字符。
   * 要永远对应同一个第三方：改名会让已有的绑定失效，拿去对接别的第三方会让 subject 撞上别人的绑定
   */
  readonly id: string
  /** 第三方的名称，例如 GitHub。登录按钮上的"使用 … 登录"、安全页的列表和绑定通知邮件都用它 */
  readonly label: MessageKey
  readonly icon: IconName
  /**
   * 返回第三方授权页的地址（https），5 秒内完成。`codeChallenge` 按 S256 生成，第三方不支持 PKCE 时可以不传它，
   * state 照样防 CSRF。`redirectUri` 是这个 Provider 固定的回调地址，管理员要把它填到第三方的控制台
   */
  authorizeUrl(args: { state: string; codeChallenge: string; redirectUri: string; ctx: Ctx }): Promise<string>
  /**
   * 用回调的参数向第三方换出身份，15 秒内完成。回调带 `error` 参数时（RFC 6749 §4.1.2.1，例如用户在第三方点了取消），
   * 核心直接按取消处理，不调用它
   */
  exchange(args: {
    /** 回调 URL 上的全部查询参数 */
    query: Readonly<Record<string, string>>
    codeVerifier: string
    redirectUri: string
    ctx: Ctx
  }): Promise<ExternalIdentity>
}

export interface ExternalIdentity {
  /**
   * 第三方那里永远指同一个人的标识：用数字 id 或 OIDC 的 `sub` 这类值，不用登录名或邮箱（它们会变）。
   * 字符范围为 `[\x21-\x7e]{1,255}`（不含空格），不合格按插件出错处理
   */
  readonly subject: string
  /** 第三方没有给就填 null，用户在"完成注册"页上自己填 */
  readonly email: string | null
  /**
   * 只在第三方确认这个人此刻拥有这个邮箱时才是 true，拿不准就填 false。核心靠它决定新账号的邮箱算不算已验证，
   * 以及能不能把这个身份绑到一个已经没有任何登录方式的同邮箱账号上
   */
  readonly emailVerified: boolean
  /** 首次登录预填：昵称 trim 后截到 255 字符；角色名通过站点角色名规则才预填 */
  readonly displayName: string | null
}
