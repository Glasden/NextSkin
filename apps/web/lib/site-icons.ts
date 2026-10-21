import type { Metadata } from 'next'
import { siteImageUrl } from './site-images'

type IconSettings = { 'site.favicon': string | null; 'site.logo': string | null }

/** 浏览器图标用哪张站点图片（ADR-0042）：上传了图标用图标，没有就用站点标志；都没有时是 null */
export function siteIconHash(settings: IconSettings): string | null {
  return settings['site.favicon'] ?? settings['site.logo']
}

/**
 * 根布局的 `<link rel="icon">`。没有上传时指向 public/ 里由标志图形生成的默认图标（`pnpm design:sync`）：
 * ICO 标了尺寸，认得 SVG 的浏览器会优先用跟着亮暗切换的 SVG。主屏幕图标用白底的那份
 */
export function iconsMetadata(hash: string | null): NonNullable<Metadata['icons']> {
  if (!hash)
    return {
      icon: [
        { url: '/favicon.ico', sizes: '32x32', type: 'image/x-icon' },
        { url: '/icon.svg', type: 'image/svg+xml' },
      ],
      apple: '/apple-icon.png',
    }
  return { icon: { url: siteImageUrl(hash), type: 'image/png' }, apple: siteImageUrl(hash, 'opaque') }
}
