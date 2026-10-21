import type { SessionUser } from '@nextskin/domain'

export type AppEnv = {
  Bindings: { peer?: string | null }
  Variables: {
    textureMaxKb?: number
    user?: SessionUser
    requestRoot: string
    profileRoot?: string
    apiLocation?: string
    omitAli: boolean
  }
}
