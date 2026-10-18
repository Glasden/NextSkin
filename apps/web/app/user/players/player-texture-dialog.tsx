'use client'

import type { ClosetItem } from '@nextskin/domain'
import { Alert, Button, Dialog, DialogClose, Input, Link, SkinFigure, TexturePicker, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { apiError, getJson, sendJson } from '../../../lib/api-client'
import { figureSrc } from '../../../lib/textures'

const PER_PAGE = 20

export interface PlayerTextureDialogProps {
  pid: number
  name: string
  slot: 'skin' | 'cape'
  /** 角色现在这个槽位上的材质 */
  current: number | null
  disabled: boolean
}

/**
 * 角色管理的“换皮肤”“换披风”：从衣柜里选一件，也可以清除（ADR-0026）。
 * 衣柜在浏览器里分页、搜索，读的是 GET /api/closet
 */
export function PlayerTextureDialog({ pid, name, slot, current, disabled }: PlayerTextureDialogProps) {
  const t = useTranslations('user.players.textures')
  const players = useTranslations('user.players')
  const common = useTranslations('common')
  const skinlib = useTranslations('skinlib')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [closet, setCloset] = useState<{ items: ClosetItem[]; total: number; q: string; page: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [selected, setSelected] = useState<string | null>(current === null ? null : String(current))
  const [pending, setPending] = useState<'apply' | 'clear' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load(q: string, page: number) {
    setLoading(true)
    setLoadFailed(false)
    const query = new URLSearchParams({ type: slot, page: String(page) })
    if (q) query.set('q', q)
    const { status, data } = await getJson(`/api/closet?${query}`)
    setLoading(false)
    if (status !== 200) {
      setLoadFailed(true)
      return
    }
    setCloset({ ...(data as { items: ClosetItem[]; total: number }), q, page })
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = new FormData(event.currentTarget).get('q')
    const q = typeof value === 'string' ? value.trim() : ''
    void load(q, 1)
  }

  async function save(tid: number | null) {
    setPending(tid === null ? 'clear' : 'apply')
    setError(null)
    const { status, data } = await sendJson('PATCH', `/api/players/${pid}`, { [slot]: tid })
    setPending(null)
    if (status === 200) {
      toast.show({ tone: 'success', title: tid === null ? t('cleared', { slot, name }) : t('applied', { slot, name }) })
      setOpen(false)
      router.refresh()
      return
    }
    setError(apiError(data)?.message ?? players('failed'))
  }

  const pageCount = closet ? Math.ceil(closet.total / PER_PAGE) : 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setError(null)
          setSelected(current === null ? null : String(current))
          void load('', 1)
        }
      }}
      trigger={
        <Button size="sm" disabled={disabled}>
          {slot === 'cape' ? players('changeCape') : players('changeSkin')}
        </Button>
      }
      title={t('title', { slot, name })}
      description={t('description')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          {current !== null && (
            <Button loading={pending === 'clear'} disabled={pending === 'apply'} onClick={() => void save(null)}>
              {t('clear', { slot })}
            </Button>
          )}
          <Button
            variant="primary"
            loading={pending === 'apply'}
            disabled={selected === null || selected === String(current) || pending === 'clear'}
            onClick={() => void save(Number(selected))}
          >
            {t('apply')}
          </Button>
        </>
      }
    >
      <form role="search" onSubmit={search} className="flex gap-2">
        <Input
          name="q"
          type="search"
          aria-label={t('searchLabel')}
          placeholder={t('searchPlaceholder')}
          maxLength={64}
          size="sm"
        />
        <Button type="submit" size="sm">
          {t('search')}
        </Button>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
      {loadFailed ? (
        <div className="flex flex-col items-start gap-2">
          <Alert tone="danger">{t('loadFailed')}</Alert>
          <Button size="sm" onClick={() => void load(closet?.q ?? '', closet?.page ?? 1)}>
            {t('retry')}
          </Button>
        </div>
      ) : !closet ? (
        <p className="text-sm text-text-muted" role="status">
          {t('loading')}
        </p>
      ) : closet.items.length ? (
        <div className="flex flex-col gap-3">
          <TexturePicker
            aria-label={t('picker', { slot })}
            value={selected}
            onValueChange={setSelected}
            disabled={loading}
            options={closet.items.map((item) => ({
              value: String(item.tid),
              name: item.name,
              figure: (
                <SkinFigure
                  src={figureSrc(item.hash, item.type)}
                  type={item.type}
                  textureScale={item.scale}
                  scale={3}
                  alt={skinlib('figureAlt', { name: item.name, type: skinlib(`types.${item.type}`) })}
                />
              ),
            }))}
          />
          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-3">
              <Button
                size="sm"
                disabled={loading || closet.page <= 1}
                onClick={() => void load(closet.q, closet.page - 1)}
              >
                {t('previous')}
              </Button>
              <span className="font-pixel text-pixel-1 text-text-muted tabular-nums">
                {t('pageStatus', { page: closet.page, count: pageCount })}
              </span>
              <Button
                size="sm"
                disabled={loading || closet.page >= pageCount}
                onClick={() => void load(closet.q, closet.page + 1)}
              >
                {t('next')}
              </Button>
            </div>
          )}
        </div>
      ) : closet.q ? (
        <p className="text-sm text-text-muted">{t('noResults', { q: closet.q })}</p>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-text">{t('empty', { slot })}</p>
          <Link render={<NextLink href={slot === 'cape' ? '/skinlib?type=cape' : '/skinlib'} />}>{t('browse')}</Link>
        </div>
      )}
    </Dialog>
  )
}
