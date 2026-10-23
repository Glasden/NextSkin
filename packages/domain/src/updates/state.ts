import { z } from 'zod'

const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
export const updateReleaseSchema = z.strictObject({
  version,
  date: z.iso.datetime(),
  notes: z.url({ protocol: /^https$/ }),
  minNode: z.int().positive(),
})
export const updateFailureSchema = z.discriminatedUnion('code', [
  z.strictObject({ at: z.iso.datetime(), code: z.literal('http'), status: z.int().min(100).max(599) }),
  z.strictObject({ at: z.iso.datetime(), code: z.enum(['network', 'invalid', 'too_large']) }),
])
export const updateStateSchema = z.strictObject({
  checkedAt: z.iso.datetime().nullable(),
  failure: updateFailureSchema.nullable(),
  latest: updateReleaseSchema.nullable(),
  notified: z
    .array(version)
    .max(20)
    .refine((values) => new Set(values).size === values.length),
  rejected: z.int().nonnegative(),
})
export type UpdateState = z.infer<typeof updateStateSchema>
export const initialUpdateState: UpdateState = {
  checkedAt: null,
  failure: null,
  latest: null,
  notified: [],
  rejected: 0,
}
