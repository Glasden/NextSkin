import type { Uid } from './dto'
import type { ClientModuleRef, IconName, MessageKey } from './ui'

/**
 * Provider：插件实现核心定义好的接口，由核心在合适的时机调用。
 * 每个 Provider 在后台可以被管理员单独启用或停用。
 *
 * 所有方法都是异步的：插件可能在另一个进程里。
 */
export interface Providers<Ctx> {
  readonly passwordHasher?: readonly PasswordHasherProvider<Ctx>[]
  readonly login?: readonly LoginProvider<Ctx>[]
  readonly captcha?: readonly CaptchaProvider<Ctx>[]
  readonly mail?: readonly MailTransportProvider<Ctx>[]
}

/**
 * 校验外部系统格式的密码哈希（AuthMe、Discuz 等）。
 *
 * 只需要校验，不需要生成：校验成功后，核心会立刻用自己的算法重新哈希并替换，
 * 所以每个用户最多经过一次插件校验。
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
 */
export interface LoginProvider<Ctx> {
  readonly id: string
  readonly label: MessageKey
  readonly icon: IconName
  authorizeUrl(args: {
    state: string
    codeChallenge: string
    redirectUri: string
    ctx: Ctx
  }): Promise<string>
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

export type CaptchaAction = 'login' | 'register' | 'forgotPassword'

/** 验证码。前端挂件运行在主域，所以提供验证码的插件必须申请 `ui.script`。 */
export interface CaptchaProvider<Ctx> {
  readonly id: string
  readonly label: MessageKey
  readonly widget: ClientModuleRef
  verify(args: { token: string; ip: string; action: CaptchaAction; ctx: Ctx }): Promise<{ ok: boolean }>
}

export interface MailMessage {
  readonly to: string
  readonly subject: string
  readonly html: string
  readonly text: string
  readonly replyTo?: string
}

/** 邮件通道。核心自带 SMTP；插件用来接各家云厂商的发信 API。 */
export interface MailTransportProvider<Ctx> {
  readonly id: string
  readonly label: MessageKey
  send(args: { message: MailMessage; ctx: Ctx }): Promise<{ messageId: string | null }>
}
