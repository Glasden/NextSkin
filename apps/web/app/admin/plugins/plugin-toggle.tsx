'use client'

import { Button, Dialog, DialogClose, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/**
 * 启用、停用插件。两个方向都先确认：启用前写明插件会在服务器上运行、要用到的高风险能力（ADR-0033），
 * 停用前写明哪些东西会停、哪些会保留
 */
export function PluginToggle({
  id,
  name,
  enabled,
  highRisk,
}: {
  id: string
  name: string
  enabled: boolean
  /** 高风险能力的说明文字，已经翻译好 */
  highRisk: readonly string[]
}) {
  const t = useTranslations('admin.plugins')
  const admin = useTranslations('admin')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function apply() {
    setPending(true)
    const { status, data } = await sendJson('POST', `/api/admin/plugins/${id}/${enabled ? 'disable' : 'enable'}`)
    setPending(false)
    setOpen(false)
    if (status === 200) toast.show({ tone: 'success', title: t(enabled ? 'disabled' : 'enabled', { name }) })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
    router.refresh()
  }

  return (
    <>
      <Button variant={enabled ? 'secondary' : 'primary'} onClick={() => setOpen(true)}>
        {t(enabled ? 'disable' : 'enable')}
      </Button>
      {open && (
        <Dialog
          alert
          open
          onOpenChange={(next) => {
            if (!next) setOpen(false)
          }}
          title={t(enabled ? 'disableTitle' : 'enableTitle', { name })}
          description={
            enabled ? (
              t('disableHint')
            ) : (
              <span className="flex flex-col gap-2">
                <span>{t('enableHint')}</span>
                {highRisk.length > 0 && (
                  <span className="text-danger">{t('enableHighRisk', { list: highRisk.join('、') })}</span>
                )}
              </span>
            )
          }
          actions={
            <>
              <DialogClose>{common('cancel')}</DialogClose>
              <Button variant={enabled ? 'danger' : 'primary'} loading={pending} onClick={() => void apply()}>
                {t(enabled ? 'disableConfirm' : 'enableConfirm')}
              </Button>
            </>
          }
        />
      )}
    </>
  )
}
