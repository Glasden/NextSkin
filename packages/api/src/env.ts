import type { SessionUser } from '@nextskin/domain'

export type AppEnv = {
  Bindings: { peer?: string | null }
  Variables: {
    user?: SessionUser
    requestRoot: string
    profileRoot?: string
    omitAli: boolean
  }
}
