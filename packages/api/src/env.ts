export type AppEnv = {
  Bindings: { peer?: string | null }
  Variables: {
    requestRoot: string
    profileRoot?: string
    omitAli: boolean
  }
}
