'use client'

import { Button, Dialog, DialogClose, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/** 卸载上传安装的插件：删掉它的表、数据、设置和插件包，不能恢复，先确认 */
export function PluginUninstall({ id, name }: { id: string; name: string }) {
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
        />
      )}
    </>
  )
}
