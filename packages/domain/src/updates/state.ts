import { z } from 'zod'

const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
export const updateReleaseSchema = z.strictObject({
  version,
  date: z.iso.datetime(),
  notes: z.url({ protocol: /^https$/ }),
  minNode: z.int().positive(),
  managerProtocol: z.int().positive(),
})
export const updateFailureSchema = z.discriminatedUnion('code', [
  z.strictObject({ at: z.iso.datetime(), code: z.literal('http'), status: z.int().min(100).max(599) }),
  z.strictObject({ at: z.iso.datetime(), code: z.enum(['network', 'invalid', 'too_large']) }),
])
export const storedUpdateState = z.strictObject({
  checkedAt: z.iso.datetime().nullable(),
  failure: updateFailureSchema.nullable(),
  releases: z.array(updateReleaseSchema).max(20),
  notified: z
    .array(version)
    .max(20)
    .refine((values) => new Set(values).size === values.length),
  rejected: z.int().nonnegative(),
})
export type UpdateState = z.infer<typeof storedUpdateState>
export const initialUpdateState: UpdateState = {
  checkedAt: null,
  failure: null,
  releases: [],
  notified: [],
  rejected: 0,
}
// 这只是检查结果的缓存：换过版本（升级或回滚）后存的形状对不上时当作没检查过，下次检查重写，
// 不能让更新页、概览和检查本身因为读不出它而失败。写入前另用 storedUpdateState 校验，自己写错了照样报错
export const updateStateSchema = storedUpdateState.catch(() => structuredClone(initialUpdateState))
