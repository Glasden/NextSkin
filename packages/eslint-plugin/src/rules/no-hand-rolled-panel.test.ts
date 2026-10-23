import { tester } from '../rule-tester.ts'
import rule from './no-hand-rolled-panel.ts'

tester.run('no-hand-rolled-panel', rule, {
  valid: [
    'const classes = "rounded-sm border border-border"',
    'const classes = "rounded-none"',
    'const classes = "rounded-mdx"',
    { code: 'const view = <Panel gap={4} />', filename: 'x.tsx' },
  ],
  invalid: [
    ...['rounded-md border border-border bg-surface p-6', 'flex sm:rounded-md', 'p-4 !rounded-md'].flatMap((value) => [
      { code: `const classes = ${JSON.stringify(value)}`, errors: [{ messageId: 'forbidden' }] },
      { code: 'const classes = `p-4 ${active} ' + value + '`', errors: [{ messageId: 'forbidden' }] },
    ]),
    {
      code: 'const view = <div className="rounded-md border border-border bg-surface" />',
      filename: 'x.tsx',
      errors: [{ messageId: 'forbidden' }],
    },
  ],
})
