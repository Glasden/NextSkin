import { tester } from '../rule-tester.ts'
import rule from './no-modulepreload.ts'

tester.run('no-modulepreload', rule, {
  valid: [
    ...[
      '<link rel="stylesheet" />',
      '<link rel="modulepreloader" />',
      '<link rel={rel} />',
      '<link rel={`module${suffix}`} />',
      '<Link rel="modulepreload" />',
      '<div rel="modulepreload" />',
      '<link {...props} />',
    ].map((jsx) => ({ code: `const view = ${jsx}`, filename: 'x.tsx' })),
    'ReactDOM.preloadModule("/module.js")',
    'createElement("link", { rel: "preload" })',
    'createElement("div", { rel: "modulepreload" })',
    'other("link", { rel: "modulepreload" })',
    'createElement("link", { rel: rel })',
    'createElement("link", { rel: `module${suffix}` })',
    'createElement("link", props)',
    'const value: string = "modulepreload"',
  ],
  invalid: [
    ...[
      '<link rel="modulepreload" />',
      '<link rel="  stylesheet MODULEPRELOAD prefetch  " />',
      '<link rel={"modulepreload"} />',
      '<link rel={`modulepreload`} />',
      '<link rel={`stylesheet\nModulePreload\tprefetch`} />',
      '<link rel={"\\u006dodulepreload"} />',
    ].map((jsx) => ({ code: `const view = ${jsx}`, filename: 'x.tsx', errors: [{ messageId: 'forbidden' }] })),
    ...[
      'createElement("link", { rel: "modulepreload" })',
      'React.createElement("link", { rel: "stylesheet MODULEPRELOAD" })',
      'X.createElement("link", { "rel": "modulepreload" })',
      'React["createElement"]("link", { ["rel"]: "modulepreload" })',
      'createElement("link", { rel: `modulepreload` })',
      'createElement(`link`, { rel: `modulepreload` })',
    ].map((code) => ({ code, errors: [{ messageId: 'forbidden' }] })),
  ],
})
