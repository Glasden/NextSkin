'use client'

import type { AdminTextureForOwner } from '@nextskin/domain'
import { Badge, SkinFigure } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { getJson } from '../../lib/api-client'
import { figureSrc } from '../../lib/textures'

const TID = /^[1-9]\d{0,9}$/

/** 输入框里的编号：空是清空，不是正整数的原样交给接口，由 zod 挂到字段上 */
export function tidValue(input: string): number | string | null {
  const value = input.trim()
  if (value === '') return null
  return TID.test(value) ? Number(value) : value
}

export type Lookup<T> =
  { state: 'idle' } | { state: 'loading' } | { state: 'found'; value: T } | { state: 'missing' } | { state: 'failed' }

/** 按 tid 查材质和主人能不能用（GET /api/admin/textures/{tid}?owner=），输入停下 300ms 之后再查 */
function useTextureLookup(input: string, owner: number): Lookup<AdminTextureForOwner> {
  const tid = TID.test(input.trim()) ? input.trim() : null
  // 结果连同查的是哪个编号一起存：输入变了，旧结果自然作废，显示"正在查找"
  const [result, setResult] = useState<{ tid: string; lookup: Lookup<AdminTextureForOwner> } | null>(null)
  useEffect(() => {
    if (tid === null) return
    let current = true
    const timer = setTimeout(() => {
      void getJson(`/api/admin/textures/${tid}?owner=${owner}`).then(({ status, data }) => {
        if (!current) return
        setResult({
          tid,
          lookup:
            status === 200
              ? { state: 'found', value: data as AdminTextureForOwner }
              : { state: status === 404 ? 'missing' : 'failed' },
        })
      })
    }, 300)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [tid, owner])
  if (tid === null) return { state: 'idle' }
  return result?.tid === tid ? result.lookup : { state: 'loading' }
}

/**
 * 输入框下面的预览：迷你展台、名字和主人能不能用。给角色换材质和加入衣柜时用（ADR-0036"页面"）；
 * 传了 slot 时还检查类型和槽位是否一致。预览只是提示，接口照样检查
 */
export function TexturePreview({ input, owner, slot }: { input: string; owner: number; slot?: 'skin' | 'cape' }) {
  const t = useTranslations('admin.textureLookup')
  const skinlib = useTranslations('skinlib')
  const lookup = useTextureLookup(input, owner)
  if (lookup.state === 'idle') return null
  if (lookup.state === 'loading')
    return (
      <p className="text-sm text-text-muted" role="status">
        {t('lookingUp')}
      </p>
    )
  if (lookup.state === 'missing')
    return <p className="text-sm text-danger">{t('textureNotFound', { tid: input.trim() })}</p>
  if (lookup.state === 'failed') return <p className="text-sm text-danger">{t('lookupFailed')}</p>
  const texture = lookup.value
  const wrongSlot = slot !== undefined && 'type' in texture && (slot === 'cape') !== (texture.type === 'cape')
  return (
    <div className="flex items-center gap-3" role="status">
      <span className="grid h-26 w-14 shrink-0 place-items-center rounded-sm bg-stage">
        {'hash' in texture && texture.scale !== null && (
          <SkinFigure
            src={figureSrc(texture.hash, texture.type)}
            type={texture.type}
            textureScale={texture.scale}
            scale={3}
            alt={skinlib('figureAlt', { name: texture.name, type: skinlib(`types.${texture.type}`) })}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-1 text-sm">
        <span className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 font-medium break-all text-text">
            {'name' in texture ? texture.name : t('privateTexture')}
          </span>
          {'type' in texture && <Badge>{skinlib(`types.${texture.type}`)}</Badge>}
          {!texture.public && <Badge>{t('private')}</Badge>}
        </span>
        {!texture.visibleToOwner ? (
          <span className="text-danger">{t('textureHidden')}</span>
        ) : wrongSlot ? (
          <span className="text-danger">{t('textureWrongSlot', { slot })}</span>
        ) : null}
      </span>
    </div>
  )
}
