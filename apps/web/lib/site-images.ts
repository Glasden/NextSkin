// 站点图片的公开地址（ADR-0042），由 Hono 提供。服务端组件和后台的设置表单共用，不引用 @nextskin/domain

/** opaque 是铺了白底的那份，给 iOS 的主屏幕图标 */
export function siteImageUrl(hash: string, variant: 'image' | 'opaque' = 'image'): string {
  return `/site-images/${hash}${variant === 'opaque' ? '.opaque' : ''}.png`
}
