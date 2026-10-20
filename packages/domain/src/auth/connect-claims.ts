import type { OAuthClaimExtensionInput, OAuthOptions, OAuthProviderExtension } from '@better-auth/oauth-provider'
import { readAuthBoolean, type CoreDatabase } from '@nextskin/db'
import { RENDERER_VERSION } from '@nextskin/skin'
import { APIError } from 'better-auth/api'
import type { Kysely } from 'kysely'
import { parsePlayerReference, READ_SCOPE, SELECT_SCOPE } from '../oauth/scopes.ts'
import { textureScaleOrNull } from '../players/queries.ts'

export function connectClaims(db: Kysely<CoreDatabase>, siteUrl: string) {
  /** 头像按材质本身的分辨率出图（k = s）：出图只缩小不放大，k 必须整除 s（textures/renders.ts） */
  async function picture(uid: number): Promise<string | undefined> {
    const row = await db
      .selectFrom('users')
      .innerJoin('textures', 'textures.id', 'users.avatar_texture_id')
      .innerJoin('texture_files', 'texture_files.hash', 'textures.hash')
      .select(['textures.hash', 'texture_files.width', 'texture_files.height'])
      .where('users.id', '=', uid)
      .executeTakeFirst()
    const k = row ? textureScaleOrNull('steve', row.width, row.height) : null
    return row && k !== null ? `${siteUrl}/render/v${RENDERER_VERSION}/head/${k}/${row.hash}.png` : undefined
  }

  async function standardClaims({ user, scopes }: { user: { id: string }; scopes: string[] }) {
    const row = await db
      .selectFrom('users')
      .select(['id', 'nickname', 'email', 'email_verified'])
      .where('id', '=', Number(user.id))
      .executeTakeFirstOrThrow()
    return {
      ...(scopes.includes('profile') ? { name: row.nickname, picture: await picture(row.id) } : {}),
      ...(scopes.includes('email') ? { email: row.email, email_verified: readAuthBoolean(row.email_verified) } : {}),
    }
  }

  async function availableProfiles(uid: number) {
    const rows = await db
      .selectFrom('players')
      .select(['uuid', 'name'])
      .where('user_id', '=', uid)
      .orderBy('id')
      .execute()
    return rows.map((row) => ({ id: row.uuid.replaceAll('-', ''), name: row.name }))
  }

  async function selectedProfile({ user, scopes, referenceId }: OAuthClaimExtensionInput) {
    if (!scopes.includes(SELECT_SCOPE)) return {}
    const pid = parsePlayerReference(referenceId)
    const row =
      pid === null
        ? undefined
        : await db
            .selectFrom('players')
            .select(['uuid', 'name'])
            .where('id', '=', pid)
            .where('user_id', '=', Number(user?.id))
            .executeTakeFirst()
    if (!row)
      throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Invalid selected profile' })
    return { selectedProfile: { id: row.uuid.replaceAll('-', ''), name: row.name } }
  }

  const extension: OAuthProviderExtension = {
    claims: {
      accessToken: selectedProfile,
      idToken: async (input) => ({
        ...(await selectedProfile(input)),
        ...(input.scopes.includes(READ_SCOPE)
          ? { availableProfiles: await availableProfiles(Number(input.user?.id)) }
          : {}),
      }),
      userInfo: async ({ user, scopes, jwt }) => ({
        aud: jwt.client_id,
        ...(scopes.includes(SELECT_SCOPE) ? { selectedProfile: jwt.selectedProfile } : {}),
        ...(scopes.includes(READ_SCOPE) ? { availableProfiles: await availableProfiles(Number(user.id)) } : {}),
      }),
    },
  }
  return {
    picture,
    providerOptions: {
      customIdTokenClaims: standardClaims,
      customUserInfoClaims: standardClaims,
      extensions: [extension],
    } satisfies Pick<OAuthOptions, 'customIdTokenClaims' | 'customUserInfoClaims' | 'extensions'>,
  }
}
