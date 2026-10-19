'use client'

import { Alert, Button, Dialog, DialogClose, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/**
 * 卸载上传安装的插件：删掉它的表、数据、设置、第三方账号绑定和插件包，不能恢复，先确认。
 * 有绑定时写明会删掉多少个，其中多少个用户之后没有别的登录方式（ADR-0034）
 */
export function PluginUninstall({
  id,
  name,
  bindings = 0,
  stranded = 0,
}: {
  id: string
  name: string
  bindings?: number
  stranded?: number
}) {
  const t = useTranslations('admin.plugins.uninstall')
  const admin = useTranslations('admin')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function uninstall() {
    setPending(true)
    const { status, data } = await sendJson('DELETE', `/api/admin/plugins/${id}`)
    setPending(false)
    setOpen(false)
    if (status === 200) {
      toast.show({ tone: 'success', title: t('done', { name }) })
      router.push('/admin/plugins')
    } else {
      toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
      router.refresh()
    }
  }

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        {t('button')}
      </Button>
      {open && (
        <Dialog
          alert
          open
          onOpenChange={(next) => {
            if (!next) setOpen(false)
          }}
          title={t('dialogTitle', { name })}
          description={t('dialogHint')}
          actions={
            <>
              <DialogClose>{common('cancel')}</DialogClose>
              <Button variant="danger" loading={pending} onClick={() => void uninstall()}>
                {t('confirm')}
              </Button>
            </>
          }
        >
          {/* 删掉绑定以后这些用户要重新绑定；只靠它登录的用户只能找回密码 */}
          {bindings > 0 && <Alert tone="warning">{t('bindings', { bindings, stranded })}</Alert>}
        </Dialog>
      )}
    </>
  )
}
