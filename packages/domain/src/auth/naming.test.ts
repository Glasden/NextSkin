import { expect, test } from 'vitest'
import { authColumnName, authTableName, coreModelNaming } from './naming.ts'

test.each([
  ['user', 'users'],
  ['verification', 'verifications'],
  ['jwks', 'jwks'],
  ['oauthClient', 'oauth_clients'],
  ['oauthClientResource', 'oauth_client_resources'],
  ['oauthRefreshToken', 'oauth_refresh_tokens'],
  ['deviceCode', 'device_codes'],
  ['twoFactor', 'two_factors'],
])('模型 %s 的表名是 %s', (model, table) => {
  expect(authTableName(model)).toBe(table)
})

test.each([
  ['user', 'name', 'nickname'],
  ['user', 'emailVerified', 'email_verified'],
  ['user', 'twoFactorEnabled', 'two_factor_enabled'],
  ['passkey', 'credentialID', 'credential_id'],
  ['oauthClient', 'requirePKCE', 'require_pkce'],
  ['oauthAccessToken', 'refreshId', 'refresh_id'],
  ['passkey', 'aaguid', 'aaguid'],
])('%s.%s 的列名是 %s', (model, field, column) => {
  expect(authColumnName(model, field)).toBe(column)
})

test('核心模型的映射覆盖 Better Auth 声明的每个字段', () => {
  const naming = coreModelNaming()
  expect(naming.user.modelName).toBe('users')
  expect(naming.user.fields).toMatchObject({ name: 'nickname', email: 'email', createdAt: 'created_at' })
  expect(naming.account.fields).toMatchObject({
    providerId: 'provider_id',
    accessTokenExpiresAt: 'access_token_expires_at',
  })
  expect(naming.session.modelName).toBe('sessions')
})
