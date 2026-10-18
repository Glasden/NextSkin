// 测试用 SQLite 旧站（sqlite-site.ts）里的账号和 UUID：e2e 只引用这些常量，不加载建库的代码
/** 旧站账号的密码，两个用户相同。哈希是 PHP password_hash 的 $2y$ 格式 */
export const OLD_SITE_PASSWORD = 'old-site-password'
export const OLD_SITE_BCRYPT = '$2y$10$wkK/5cJypoTtq93tmz5OR.0X8WAdPOnjNybvmzgl56aCrPQa.7u.K'

export const OLD_SITE = {
  owner: { email: 'owner@old.example.test', nickname: 'Owner' },
  player: { email: 'alex@old.example.test', nickname: 'Alex' },
  steveUuid: '0f8d2c4b6a1e4f3d8c7b9a6e5d4c3b2a',
  /** Alex 在 uuid 表里的两个值：第一个是游戏服务器上在用的 */
  alexUuids: ['1a2b3c4d5e6f40718293a4b5c6d7e8f9', '9f8e7d6c5b4a43218f7e6d5c4b3a2918'],
} as const
