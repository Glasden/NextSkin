import { tester } from '../rule-tester.ts'
import rule from './no-next-public-env.ts'

tester.run('no-next-public-env', rule, {
  valid: [
    'const port: string | undefined = process.env.PORT',
    'const NEXT_PRIVATE_KEY = 1',
    'const value = "prefixNEXT_PUBLIC"',
    '// NEXT_PUBLIC_X\nconst value = `public ${name}`',
    { code: 'const view = <div title="PUBLIC_X" />', filename: 'x.tsx' },
  ],
  invalid: [
    { code: 'process.env.NEXT_PUBLIC_SITE', errors: [{ messageId: 'forbidden' }] },
    { code: 'const NEXT_PUBLIC_SITE: string = "site"', errors: [{ messageId: 'forbidden' }] },
    { code: 'const { NEXT_PUBLIC_SITE: site } = env', errors: [{ messageId: 'forbidden' }] },
    { code: 'const { NEXT_PUBLIC_SITE } = env', errors: [{ messageId: 'forbidden' }, { messageId: 'forbidden' }] },
    { code: 'const obj = { NEXT_PUBLIC_SITE: site }', errors: [{ messageId: 'forbidden' }] },
    { code: 'env["NEXT_PUBLIC_SITE"]', errors: [{ messageId: 'forbidden' }] },
    { code: 'const s = "prefix NEXT_PUBLIC_SITE suffix"', errors: [{ messageId: 'forbidden' }] },
    { code: 'const s = `prefix NEXT_PUBLIC_${name}`', errors: [{ messageId: 'forbidden' }] },
    { code: 'const s = `${name}NEXT_PUBLIC_SITE`', errors: [{ messageId: 'forbidden' }] },
    { code: 'const s = "NEXT_\\u0050UBLIC_SITE"', errors: [{ messageId: 'forbidden' }] },
    { code: 'const s = `NEXT_\\u0050UBLIC_SITE`', errors: [{ messageId: 'forbidden' }] },
    { code: 'const view = <div title="NEXT_PUBLIC_SITE" />', filename: 'x.tsx', errors: [{ messageId: 'forbidden' }] },
  ],
})
