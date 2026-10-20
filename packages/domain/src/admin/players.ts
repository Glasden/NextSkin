/**
 * 后台的角色管理（ADR-0036"后台的角色管理"）：改名、换材质、转让、删除。角色按主人判断"能对谁做"：先锁自己、
 * 检查 players.manage；主人在加锁之前读出，锁住主人之后按 user_id = 主人重读角色，读不到（这期间被转让或删除了）
 * 返回 player_not_found。设置、邮件是否配置在事务外读好：读它们用的是 db，SQLite 只有一个连接，在事务里读会死锁
 */
import { deletePlayerAuthorizations } from '../oauth/revoke.ts'
import { isUniqueViolation, toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { Player } from '@nextskin/plugin-sdk'
import type { Transaction } from 'kysely'
import { outranks } from '../access/permissions.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import { validatePlayerName } from '../players/create.ts'
import { changePlayer, toPlayer } from '../players/manage.ts'
import { lockTexture } from '../textures/manage.ts'
import { authorize, lockTarget, type TargetUser } from './context.ts'
import { notifyAccountChanged, readNoticeContext } from './notify.ts'
import type { AdminOptions } from './service.ts'
import type { AdminActor, AdminPlayerUpdate } from './types.ts'

function rereadPlayer(tx: Transaction<CoreDatabase>, pid: number, owner: number) {
  return tx.selectFrom('players').selectAll().where('id', '=', pid).where('user_id', '=', owner).executeTakeFirst()
}

export function createAdminPlayers(options: AdminOptions) {
  const { db, settings, events, now, mail, jobs } = options

  /** 锁住自己和主人，确认能管理主人，再按主人重读角色 */
  async function managedPlayer(tx: Transaction<CoreDatabase>, actor: AdminActor, pid: number) {
    const eventActor = await authorize(tx, actor, 'players.manage')
    const before = await tx.selectFrom('players').select('user_id').where('id', '=', pid).executeTakeFirst()
    if (!before) throw new DomainError('player_not_found')
    // 主人的账号删掉时，角色随之删除
    const owner = await lockTarget(tx, before.user_id)
    const row = owner && (await rereadPlayer(tx, pid, owner.id))
    if (!owner || !row) throw new DomainError('player_not_found')
    if (!outranks(eventActor.role, owner.role)) throw new DomainError('user_not_manageable')
    return { eventActor, owner, row }
  }

  /**
   * 改名、换材质：主体和用户侧共用（players/manage.ts 的 changePlayer），不收积分，UUID 不变（不变量 2）。
   * 材质要对主人可见、类型和槽位一致，不要求在主人的衣柜里。改了几项各写一条审计；改名给主人发通知，换材质不发
   */
  async function updatePlayer(actor: AdminActor, pid: number, input: AdminPlayerUpdate): Promise<Player> {
    if (input.name === undefined && input.skin === undefined && input.cape === undefined)
      throw new DomainError('invalid_request')
    const values = await settings.read(['player.nameRule', 'player.nameRegex', 'player.nameLength'])
    const name = input.name === undefined ? undefined : validatePlayerName(input.name, values)
    const notice = await readNoticeContext(mail, settings)
    try {
      return await transactionWithRetry(db, async (tx) => {
        const { eventActor, owner, row } = await managedPlayer(tx, actor, pid)
        const timestamp = toIsoTimestamp(now())
        const { player, renamed, texturesChanged } = await changePlayer(
          tx,
          events,
          row,
          { name, skin: input.skin, cape: input.cape },
          { actor: eventActor, requireCloset: false, now: timestamp },
        )
        const subject = { type: 'user', id: owner.id }
        if (renamed) {
          await audit(tx, {
            actor: eventActor,
            action: 'player.rename',
            subject,
            details: { pid, uuid: row.uuid, from: row.name, to: player.name },
            ip: actor.ip,
            now: timestamp,
          })
          await notifyAccountChanged(tx, jobs, notice, {
            uid: owner.id,
            to: owner.email,
            changes: [{ kind: 'playerRenamed', from: row.name, to: player.name }],
            at: timestamp,
          })
        }
        if (texturesChanged)
          await audit(tx, {
            actor: eventActor,
            action: 'player.setTextures',
            subject,
            details: {
              pid,
              name: player.name,
              uuid: row.uuid,
              ...(player.skin === row.skin_texture_id ? {} : { skin: { from: row.skin_texture_id, to: player.skin } }),
              ...(player.cape === row.cape_texture_id ? {} : { cape: { from: row.cape_texture_id, to: player.cape } }),
            },
            ip: actor.ip,
            now: timestamp,
          })
        return player
      })
    } catch (error) {
      // PG 的唯一冲突会使事务失效，必须在事务回滚后转换领域错误。
      if (isUniqueViolation(db, error)) throw new DomainError('player_name_taken')
      throw error
    }
  }

  /**
   * 转让（ADR-0036"转让"）：UUID、名字不变，`score_paid` 清零、原主人付的积分不退；新主人看不到的材质从角色上清掉；
   * 同一个事务里删掉绑定这个角色的启动器令牌和设备授权的选择，角色再转回原主人时它们也不会重新生效。
   * 加锁：自己 → 原主人和新主人按 uid 升序 → 材质。所有改角色的写入都先锁主人，锁住两个主人之后角色不会再变
   */
  async function transferPlayer(actor: AdminActor, pid: number, uid: number): Promise<Player> {
    const notice = await readNoticeContext(mail, settings)
    return transactionWithRetry(db, async (tx) => {
      const eventActor = await authorize(tx, actor, 'players.manage')
      const before = await tx.selectFrom('players').select('user_id').where('id', '=', pid).executeTakeFirst()
      if (!before) throw new DomainError('player_not_found')
      const locked = new Map<number, TargetUser | undefined>()
      for (const id of [...new Set([before.user_id, uid])].sort((a, b) => a - b))
        locked.set(id, await lockTarget(tx, id))
      const owner = locked.get(before.user_id)
      const row = owner && (await rereadPlayer(tx, pid, owner.id))
      if (!owner || !row) throw new DomainError('player_not_found')
      const recipient = locked.get(uid)
      if (!recipient) throw new DomainError('user_not_found')
      if (!outranks(eventActor.role, owner.role) || !outranks(eventActor.role, recipient.role))
        throw new DomainError('user_not_manageable')
      if (recipient.id === owner.id) return toPlayer(row)

      // 别人上传的私有材质新主人看不到，包括原主人的；公开材质和新主人自己的私有材质留着
      const hidden = new Set<number>()
      const tids = [...new Set([row.skin_texture_id, row.cape_texture_id])].filter((tid) => tid !== null)
      for (const tid of tids.sort((a, b) => a - b)) {
        const texture = await lockTexture(tx, tid)
        if (texture && texture.is_public === 0 && texture.uploader_id !== recipient.id) hidden.add(tid)
      }
      const skin = row.skin_texture_id !== null && hidden.has(row.skin_texture_id) ? null : row.skin_texture_id
      const cape = row.cape_texture_id !== null && hidden.has(row.cape_texture_id) ? null : row.cape_texture_id
      const timestamp = toIsoTimestamp(now())
      const patch = {
        user_id: recipient.id,
        score_paid: 0,
        skin_texture_id: skin,
        cape_texture_id: cape,
        updated_at: timestamp,
      }
      await tx.updateTable('players').set(patch).where('id', '=', pid).where('user_id', '=', owner.id).execute()
      await tx.deleteFrom('yggdrasil_tokens').where('player_id', '=', pid).execute()
      await tx.deleteFrom('device_code_selections').where('player_id', '=', pid).execute()
      await deletePlayerAuthorizations(tx, pid)

      // 两个事件用同一个转让之后的 Player：先发清掉材质的 texturesChanged，再发 transferred
      const player = toPlayer({ ...row, ...patch })
      if (skin !== row.skin_texture_id || cape !== row.cape_texture_id)
        await events.emit(
          tx,
          'player.texturesChanged',
          eventActor,
          { player, previous: { skin: row.skin_texture_id, cape: row.cape_texture_id } },
          timestamp,
        )
      await events.emit(tx, 'player.transferred', eventActor, { player, previousUid: owner.id }, timestamp)
      // 转让动了两个人的持有物，各记一条（ADR-0036"审计日志"）
      const details = {
        pid,
        name: row.name,
        uuid: row.uuid,
        from: owner.id,
        to: recipient.id,
        scorePaid: row.score_paid,
        cleared: {
          ...(skin === row.skin_texture_id ? {} : { skin: row.skin_texture_id }),
          ...(cape === row.cape_texture_id ? {} : { cape: row.cape_texture_id }),
        },
      }
      for (const user of [owner, recipient])
        await audit(tx, {
          actor: eventActor,
          action: 'player.transfer',
          subject: { type: 'user', id: user.id },
          details,
          ip: actor.ip,
          now: timestamp,
        })
      await notifyAccountChanged(tx, jobs, notice, {
        uid: owner.id,
        to: owner.email,
        changes: [{ kind: 'playerTransferredOut', name: row.name }],
        at: timestamp,
      })
      await notifyAccountChanged(tx, jobs, notice, {
        uid: recipient.id,
        to: recipient.email,
        changes: [{ kind: 'playerTransferredIn', name: row.name }],
        at: timestamp,
      })
      return player
    })
  }

  /**
   * 删除：不退积分，同 BS 的后台删除和 ADR-0027 的管理员删除材质，需要补偿时用"改积分"。
   * 启动器令牌和设备授权的选择由外键级联删除（ADR-0030）
   */
  async function deletePlayer(actor: AdminActor, pid: number): Promise<void> {
    const notice = await readNoticeContext(mail, settings)
    await transactionWithRetry(db, async (tx) => {
      const { eventActor, owner, row } = await managedPlayer(tx, actor, pid)
      const timestamp = toIsoTimestamp(now())
      await deletePlayerAuthorizations(tx, pid)
      await tx.deleteFrom('players').where('id', '=', pid).where('user_id', '=', owner.id).execute()
      await events.emit(
        tx,
        'player.deleted',
        eventActor,
        { pid, uid: owner.id, name: row.name, uuid: row.uuid },
        timestamp,
      )
      await audit(tx, {
        actor: eventActor,
        action: 'player.delete',
        subject: { type: 'user', id: owner.id },
        details: { pid, name: row.name, uuid: row.uuid, scorePaid: row.score_paid },
        ip: actor.ip,
        now: timestamp,
      })
      await notifyAccountChanged(tx, jobs, notice, {
        uid: owner.id,
        to: owner.email,
        changes: [{ kind: 'playerDeleted', name: row.name }],
        at: timestamp,
      })
    })
  }

  return { updatePlayer, transferPlayer, deletePlayer }
}
