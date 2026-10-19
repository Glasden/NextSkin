'use client'

import { Button, Field, Input, Textarea } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import { useState } from 'react'
import { postJson } from '../../../../lib/api-client'
import { ActionDialog } from './action-dialog'

const MAX_SCORE = 2147483647

/**
 * 改积分只按增量（ADR-0036"改积分"）：管理员打开表单之后，用户的签到和花费照常发生，写绝对值会把它们覆盖。
 * 页面显示当前余额和改完的结果；扣到负数、超过上限由接口拒绝，这里先提示
 */
export function ScoreDialog({ uid, nickname, score }: { uid: number; nickname: string; score: number }) {
  const t = useTranslations('admin.userDetail.score')
  const format = useFormatter()
  const [delta, setDelta] = useState('')
  const parsed = /^[+-]?\d{1,10}$/.test(delta.trim()) ? Number(delta.trim()) : null
  const result = parsed === null || parsed === 0 ? null : score + parsed
  const outOfRange = result !== null && parsed !== null && ((parsed < 0 && result < 0) || result > MAX_SCORE)

  return (
    <ActionDialog
      id="admin-score"
      fields={['delta', 'note']}
      trigger={<Button size="sm">{t('adjust')}</Button>}
      title={t('adjustTitle', { nickname })}
      description={t('adjustHint')}
      confirm={t('adjustConfirm')}
      onOpen={() => setDelta('')}
      send={(values) =>
        postJson(`/api/admin/users/${uid}/score`, {
          delta: parsed ?? Number.NaN,
          note: typeof values.note === 'string' && values.note.trim() !== '' ? values.note.trim() : undefined,
        })
      }
      done={(data) => t('adjusted', { score: format.number((data as { score: number }).score) })}
    >
      <Field
        label={t('delta')}
        name="delta"
        description={
          result === null
            ? t('current', { score: format.number(score) })
            : outOfRange
              ? t('outOfRange', { score: format.number(score) })
              : t('preview', { from: format.number(score), to: format.number(result) })
        }
      >
        {/* 不用 inputMode="numeric"：iOS 的数字键盘没有负号，扣分输不进去 */}
        <Input
          pattern="[+\-]?[0-9]+"
          required
          autoComplete="off"
          value={delta}
          onValueChange={setDelta}
          placeholder={t('deltaPlaceholder')}
        />
      </Field>
      <Field label={t('note')} name="note" description={t('noteHint')}>
        <Textarea maxLength={200} rows={2} />
      </Field>
    </ActionDialog>
  )
}
