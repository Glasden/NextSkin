import { tester } from '../rule-tester.ts'
import rule from './no-script-without-nonce.ts'

tester.run('no-script-without-nonce', rule, {
  valid: [
    ...[
      '<script nonce={nonce} src="/script.js" />',
      '<script nonce="request-nonce" />',
      '<script nonce={nonce}>{code}</script>',
      '<script nonce={nonce} dangerouslySetInnerHTML={{ __html: code }} />',
      '<script {...props} nonce={nonce} />',
      '<script nonce={nonce} {...props} />',
      '<Script src="/script.js" />',
      '<x.script />',
      '<svg:script />',
      '<div />',
    ].map((jsx) => ({ code: `const view = ${jsx}`, filename: 'x.tsx' })),
    'document.createElement("script")',
    'React.createElement("script", { src: "/script.js" })',
    'createElement("script", null, code)',
  ],
  invalid: [
    '<script />',
    '<script src="/script.js" />',
    '<script>{code}</script>',
    '<script dangerouslySetInnerHTML={{ __html: code }} />',
    '<script {...props} />',
    '<script {...{ nonce }} />',
    '<script Nonce={nonce} />',
    '<script csp:nonce={nonce} />',
    '<script>{<span nonce={nonce} />}</script>',
  ].map((jsx) => ({ code: `const view = ${jsx}`, filename: 'x.tsx', errors: [{ messageId: 'forbidden' }] })),
})
