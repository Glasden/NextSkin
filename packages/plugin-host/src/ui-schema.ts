import type { SlotName } from '@nextskin/plugin-sdk'
import { z } from 'zod'

export const widgetSlots = {
  'user.dashboard': 'user',
  'admin.dashboard': 'admin',
} as const satisfies Record<SlotName, 'user' | 'admin'>
export const MAX_WIDGETS_PER_SLOT = 2

export const pluginPathSchema = z
  .string()
  .startsWith('/')
  .refine((value) => {
    if (/[\\#]/.test(value)) return false
    const path = value.split('?')[0]!
    return (
      path === '/' ||
      path
        .slice(1)
        .split('/')
        .every((segment) => {
          try {
            const decoded = decodeURIComponent(segment)
            return decoded !== '' && decoded !== '.' && decoded !== '..' && !/[\\/#]/.test(decoded)
          } catch {
            return false
          }
        })
    )
  }, '路径不能有 .、..、空段、反斜杠或 #')

const base = {
  name: z.string(),
  label: z.string(),
  required: z.boolean().optional(),
  help: z.string().optional(),
}
const text = { placeholder: z.string().optional(), maxLength: z.number().int().min(0).optional() }
export const pluginFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('text'), ...text }),
  z.strictObject({ ...base, type: z.literal('textarea'), ...text }),
  z.strictObject({ ...base, type: z.literal('password'), ...text }),
  z.strictObject({ ...base, type: z.literal('number'), placeholder: z.string().optional() }),
  z.strictObject({ ...base, type: z.literal('boolean') }),
  z.strictObject({
    ...base,
    type: z.literal('select'),
    options: z.array(z.strictObject({ value: z.string(), label: z.string() })).min(1),
  }),
])
