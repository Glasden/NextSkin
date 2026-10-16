import { tester } from '../rule-tester.ts'
import rule from './no-next-image.ts'

tester.run('no-next-image', rule, {
  valid: [
    'import Link from "next/link"',
    'export { Image } from "@nextskin/ui"',
    'const name: string = "next/image"; import(name)',
    'require(moduleName)',
    'loader("next/image")',
    'require("other", "next/image")',
    'import("other", { with: { type: "next/image" } })',
    { code: 'const view = <img src={url} />', filename: 'x.tsx' },
  ],
  invalid: [
    ...['next/image', 'next/legacy/image'].flatMap((source) =>
      [
        `import Image from '${source}'`,
        `import '${source}'`,
        `import type { ImageProps } from '${source}'`,
        `export { default as Image } from '${source}'`,
        `export * from '${source}'`,
        `export * as image from '${source}'`,
        `import('${source}')`,
        `require('${source}')`,
      ].map((code) => ({ code, errors: [{ messageId: 'forbidden' }] })),
    ),
    {
      code: 'import Image from "next/image"; const view = <Image src={url} />',
      filename: 'x.tsx',
      errors: [{ messageId: 'forbidden' }],
    },
  ],
})
