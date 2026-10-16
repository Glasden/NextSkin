import { tester } from '../rule-tester.ts'
import rule from './no-use-server.ts'

tester.run('no-use-server', rule, {
  valid: [
    'const value: string = "use server"',
    'function action() { return "use server" }',
    '"use client"; const value = 1',
    'const values = ["use server"]',
    'run("use server")',
    'function action() { run(); "use server" }',
    '("use server")',
    { code: 'const view = <div title="use server" />', filename: 'x.tsx' },
  ],
  invalid: [
    ...[
      '"use server"; export async function action() {}',
      'async function action(): Promise<void> { "use server" }',
      'const action = async () => { "use server" }',
      'const action = async function () { "use server" }',
      '"use strict"; "use server"; const value = 1',
    ].map((code) => ({ code, errors: [{ messageId: 'forbidden' }] })),
    {
      code: '"use server"; function action() { "use server" }',
      errors: [{ messageId: 'forbidden' }, { messageId: 'forbidden' }],
    },
    {
      code: '"use server"; const view = <div />',
      filename: 'x.tsx',
      errors: [{ messageId: 'forbidden' }],
    },
  ],
})
