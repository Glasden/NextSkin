import type { TextureType, UserRole } from '@nextskin/db'
import type { PrivateUser as PluginPrivateUser, Texture as PluginTexture } from '@nextskin/plugin-sdk'

// 核心对自己的枚举做判断，不能依赖 SDK 为未来次版本开放的联合。
export type PrivateUser = Omit<PluginPrivateUser, 'role'> & { readonly role: UserRole }
export type Texture = Omit<PluginTexture, 'type'> & { readonly type: TextureType }
