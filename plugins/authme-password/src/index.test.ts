import { buildManifest } from '@nextskin/plugin-host'
import { expect, test } from 'vitest'
import { verifyAuthme } from './index.ts'
import plugin from './official.ts'

// AuthMe 自己的测试向量（AuthMeReloaded 的 Sha256Test、Salted2Md5Test、SaltedSha512Test）
const passwords = ['password', 'PassWord1', '&^%te$t?Pw@_', 'âË_3(íù*']
const sha256 = [
  '$SHA$11aa0706173d7272$dbba96681c2ae4e0bfdf226d70fbbc5e4ee3d8071faa613bc533fe8a64817d10',
  '$SHA$3c72a18a29b08d40$8e50a7a4f69a80f4893dc921eac84bd74b3f9ebfa22908302c9965eac3aa45e5',
  '$SHA$584cea1cfab90030$adc006330e73d81e463fe02a4fe9b17bdbbcc05955bff72fb27cf2089f0b3859',
  '$SHA$0b503d90dd9949d4$ba70c330242e0daa9a154ec9f4cce7f01dd05aff489d37c653e36a507c74d84f',
]
const salted2md5 = [
  ['9f3d13dc01a6fe61fd669954174399f3', '9b5f5749'],
  ['b28c32f624a4eb161d6adc9acb5bfc5b', 'f750ba32'],
  ['38dcb83cc68424afe3cda012700c2bb1', 'eb2c3394'],
  ['ad25606eae5b760c8a2469d65578ac39', '04eee598'],
].map(([hash, salt]) => `$authme$salted2md5$${salt}$${hash}`)
const saltedsha512 = [
  [
    'dea7a37cecf5384ae8e347fd1411efb51364b6ba1b328695de3b354612c1d7010807e8b7051c40f740e498490e1f133e2c2408327d13fbdd68e1b1f6d548e624',
    '29f8a3c52147f987fee7ba3e0fb311bd',
  ],
  [
    '7c06225aac574d2dc7c81a2ed306637adf025715f52083e05bdab014faaa234e24a97d0e69ea0108dfa77cc9228e58be319ee677e679b5d1ad168d40e50a42f6',
    '8ea37b85d020b98f60c0fe9b8ec9296c',
  ],
  [
    '55711adbe03c9616f3505f0d57077fdd528c32243eb6f9840c1a6ff9e553940d6b89790750ebd52ebda63ca793fbe9980d54057af40836820c648750fe22d49c',
    '9f58079631ef21d32b4710694f1f461b',
  ],
  [
    '29dc5be8702975ea4563ed3de5b145e2d2f1c37ae661bbe0d3e94d964402cf09d539d65f3b90ff6921ea3d40727f76fb38fb34d1e5c2d62238c4e0203efc372f',
    '048bb76168265d906f1fd1f81d0616a9',
  ],
].map(([hash, salt]) => `$authme$saltedsha512$${salt}$${hash}`)

test.each([
  ['SHA256', sha256],
  ['SALTED2MD5', salted2md5],
  ['SALTEDSHA512', saltedsha512],
])('%s：AuthMe 的测试向量都通过，换一个密码都不通过', (_, hashes) => {
  hashes.forEach((hash, i) => {
    expect(verifyAuthme(passwords[i]!, hash)).toBe(true)
    expect(verifyAuthme(passwords[(i + 1) % passwords.length]!, hash)).toBe(false)
  })
})

test('格式不对的哈希不通过，也不抛错', () => {
  for (const hash of [
    '',
    'test',
    '$t$test$',
    '$SHA$Test$$$$',
    '$$$$$',
    '$SHA$$dbba96681c2ae4e0bfdf226d70fbbc5e4ee3d8071faa613bc533fe8a64817d10',
    // 大写的摘要：AuthMe 写的都是小写
    sha256[0]!.toUpperCase().replace('$sha$', '$SHA$'),
    '$authme$salted2md5$9b5f5749$9f3d13dc01a6fe61fd669954174399f',
    '$authme$md5$9b5f5749$9f3d13dc01a6fe61fd669954174399f3',
    '$authme$salted2md5$9b5f-5749$9f3d13dc01a6fe61fd669954174399f3',
    `${salted2md5[0]}$`,
  ])
    expect(verifyAuthme('password', hash)).toBe(false)
})

test('manifest：不申请能力，认领 $SHA$ 和 $authme$ 两种前缀', () => {
  const manifest = buildManifest(plugin.definition, plugin.package)
  expect(manifest).toMatchObject({
    id: 'authme-password',
    capabilities: [],
    network: [],
    settingsSchema: null,
    providers: {
      passwordHasher: [{ id: 'authme', label: 'hasher.authme', detect: { prefix: ['$SHA$', '$authme$'] } }],
      login: [],
    },
  })
})
