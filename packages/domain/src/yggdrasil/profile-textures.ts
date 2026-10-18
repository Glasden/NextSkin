import type { CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import type { createCloset } from '../closet/service.ts'
import { DomainError } from '../errors.ts'
import type { createPlayerManagement } from '../players/manage.ts'
import { normalizeUuidLookup } from '../players/queries.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import type { createTextureUpload } from '../textures/upload.ts'
import { validateTextureName } from '../textures/validation.ts'
import { forbidden, YggdrasilError } from './errors.ts'
import type { Tokens } from './tokens.ts'

export interface ResetTextureInput {
  accessToken: string | null
  uuid: string
  type: string
}
export interface UploadTextureInput extends ResetTextureInput {
  file: { bytes: Uint8Array; filename: string } | null
  model: string | null
}

function wrapError(error: unknown, locale: string | null): never {
  if (error instanceof DomainError) {
    const code = error.code
    const kind =
      code === 'texture_file_invalid' ||
      code === 'texture_size_invalid' ||
      code === 'texture_file_too_large' ||
      code.startsWith('texture_name_') ||
      code === 'texture_type_mismatch' ||
      code === 'texture_type_invalid'
        ? 'IllegalArgumentException'
        : ['score_insufficient', 'user_banned', 'email_not_verified', 'too_many_requests'].includes(code)
          ? 'ForbiddenOperationException'
          : code === 'player_not_found'
            ? 'NotFoundException'
            : null
    if (kind) throw new YggdrasilError(kind, `errors.${code}`, locale, error.params)
  }
  throw error
}

export function createProfileTextures(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  tokens: Tokens
  upload: ReturnType<typeof createTextureUpload>
  closet: ReturnType<typeof createCloset>
  players: ReturnType<typeof createPlayerManagement>
}) {
  const { db, settings, tokens, upload, closet, players } = options
  async function authorize(input: ResetTextureInput) {
    const token = await tokens.readToken(input.accessToken, true, true)
    tokens.assertOwned(token, true)
    const uuid = normalizeUuidLookup(input.uuid)
    const player =
      uuid === null
        ? null
        : await db
            .selectFrom('players')
            .select(['id', 'user_id', 'name', 'uuid'])
            .where('uuid', '=', uuid)
            .executeTakeFirst()
    if (!player || player.uuid !== uuid)
      throw new YggdrasilError('NotFoundException', 'yggdrasil.errors.player_not_found', token.locale)
    if (player.user_id !== token.user_id) throw forbidden('profile_not_owned', token.locale)
    if (input.type !== 'skin' && input.type !== 'cape')
      throw new YggdrasilError('IllegalArgumentException', 'yggdrasil.errors.texture_type_invalid', token.locale, {
        type: input.type,
      })
    return { token, player, actor: { uid: token.user_id }, slot: input.type }
  }
  return {
    async uploadTexture(
      input: UploadTextureInput,
      beforeUpload?: (uid: number) => void | Promise<void>,
    ): Promise<void> {
      const { token, player, actor, slot } = await authorize(input)
      try {
        await beforeUpload?.(actor.uid)
        if (!input.file) throw new DomainError('texture_file_invalid')
        const type = slot === 'cape' ? 'cape' : input.model === 'slim' ? 'alex' : 'steve'
        const values = await settings.read(['texture.nameRegex'])
        let name: string
        try {
          const filename = input.file.filename
          const extension = filename.lastIndexOf('.png')
          const stem = extension < 0 ? filename : filename.slice(0, extension) + filename.slice(extension + 4)
          name = validateTextureName(stem, values['texture.nameRegex'])
        } catch (error) {
          if (!(error instanceof DomainError)) throw error
          name = player.name
        }
        let tid: number
        try {
          tid = (await upload(actor, { bytes: input.file.bytes, name, type, public: false })).texture.tid
        } catch (error) {
          if (
            !(error instanceof DomainError) ||
            error.code !== 'texture_duplicate' ||
            typeof error.params?.tid !== 'number'
          )
            throw error
          tid = error.params.tid
          const texture = await db.selectFrom('textures').select('type').where('id', '=', tid).executeTakeFirstOrThrow()
          if (texture.type !== type)
            throw new YggdrasilError(
              'IllegalArgumentException',
              'yggdrasil.errors.texture_model_mismatch',
              token.locale,
            )
          const item = await db
            .selectFrom('closet_items')
            .select('texture_id')
            .where('user_id', '=', actor.uid)
            .where('texture_id', '=', tid)
            .executeTakeFirst()
          if (!item) {
            try {
              await closet.add(actor, { tid })
            } catch (error) {
              if (!(error instanceof DomainError) || error.code !== 'closet_item_exists') throw error
            }
          }
        }
        await players.update(actor, player.id, slot === 'skin' ? { skin: tid } : { cape: tid })
      } catch (error) {
        wrapError(error, token.locale)
      }
    },
    async resetTexture(input: ResetTextureInput): Promise<void> {
      const { token, player, actor, slot } = await authorize(input)
      try {
        await players.update(actor, player.id, slot === 'skin' ? { skin: null } : { cape: null })
      } catch (error) {
        wrapError(error, token.locale)
      }
    },
  }
}
