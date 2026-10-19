import type { Capability } from '@nextskin/plugin-sdk'

/**
 * 安装界面需要醒目提示的能力。
 * 另外，提供 passwordHasher / login 这两类 Provider 的插件会接触到明文密码或第三方身份，
 * 同样按高风险展示（由核心根据 manifest 判断）。
 */
export const highRiskCapabilities = ['users.readPrivate', 'textures.readFile'] as const satisfies readonly Capability[]
