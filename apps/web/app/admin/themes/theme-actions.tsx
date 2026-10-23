'use client'

import { Button, Switch, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/**
 * 主题卡片底部的操作：启用开关和“设为默认”。每次只交改动的那一项，两个超级管理员同时改不会互相覆盖（ADR-0057）。
 * 默认主题的开关关不掉，旁边写明原因；missing：启用了但现在用不上的主题，只能关掉
 */
export function ThemeActions({
  id,
  name,
  enabled,
  isDefault,
  missing = false,
}: {
  id: string
  name: string
  enabled: boolean
  isDefault: boolean
  missing?: boolean
}) {
  const t = useTranslations('admin.themes')
  const router = useRouter()
  const toast = useToast()
  const hintId = useId()
  const [pending, setPending] = useState<'switch' | 'default' | null>(null)

  async function update(change: { enable: string } | { disable: string } | { default: string }) {
    setPending('default' in change ? 'default' : 'switch')
    const { status, data } = await sendJson('PATCH', '/api/admin/themes', change)
    setPending(null)
    if (status === 200) {
      const message = 'default' in change ? 'defaultChanged' : 'enable' in change ? 'enabled' : 'disabled'
      toast.show({ tone: 'success', title: t(message, { name }) })
    } else toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    router.refresh()
  }

  return (
    <>
      <Switch
        checked={enabled}
        disabled={isDefault || pending !== null}
        aria-describedby={isDefault ? hintId : undefined}
        onCheckedChange={(checked) => void update(checked ? { enable: id } : { disable: id })}
      >
        {t('enable')}
      </Switch>
      {isDefault ? (
        <span id={hintId} className="text-sm text-pretty text-text-muted">
          {t('defaultHint')}
        </span>
      ) : (
        !missing && (
          <Button
            size="sm"
            loading={pending === 'default'}
            disabled={pending === 'switch'}
            onClick={() => void update({ default: id })}
          >
            {t('setDefault')}
          </Button>
        )
      )}
    </>
  )
}
