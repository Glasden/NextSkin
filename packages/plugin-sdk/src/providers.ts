import type { Uid } from './dto'
import type { IconName, MessageKey } from './ui'

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
 * 校验外部系统格式的密码哈希（AuthMe、Discuz 等）。网页登录和启动器登录都经过它。
 *
 * 只需要校验，不需要生成：校验成功后，核心会立刻用自己的算法重新哈希并替换，
 * 所以每个用户最多经过一次插件校验。明文密码会交给插件，安装时按高风险展示。
 */
export interface PasswordHasherProvider<Ctx> {
  readonly id: string
  readonly label: MessageKey
  /** 声明式识别规则，由核心在本进程内匹配，不发生跨进程调用。 */
  readonly detect: {
    readonly prefix?: readonly string[]
    /** 正则表达式源码 */
    readonly pattern?: string
  }
  verify(args: { password: string; hash: string; uid: Uid; ctx: Ctx }): Promise<boolean>
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
