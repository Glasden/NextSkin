import { expect, test as base, type ConsoleMessage } from '@playwright/test'

type CspViolation = {
  effectiveDirective: string
  blockedURI: string
  source: string
  sample: string
}

const prefix = 'nextskin:csp: '

export { expect }

export const test = base.extend<{ cspViolations: CspViolation[] }>({
  cspViolations: [
    async ({ browser }, useFixture) => {
      const violations: CspViolation[] = []
      const removeListeners: (() => void)[] = []
      // eslint-disable-next-line @typescript-eslint/unbound-method -- 调用时用 apply 绑定 browser，收尾还原同一个方法。
      const newContext = browser.newContext

      // 包住创建入口，测试自己开的访客、管理员上下文也要在加载文档前装好监听。
      browser.newContext = async (...args) => {
        const context = await newContext.apply(browser, args)
        const onConsole = (message: ConsoleMessage) => {
          const text = message.text()
          if (message.type() === 'error' && text.startsWith(prefix))
            violations.push(JSON.parse(text.slice(prefix.length)) as CspViolation)
        }
        context.on('console', onConsole)
        removeListeners.push(() => context.off('console', onConsole))
        await context.addInitScript((prefix) => {
          document.addEventListener('securitypolicyviolation', (event) => {
            console.error(
              prefix +
                JSON.stringify({
                  effectiveDirective: event.effectiveDirective,
                  blockedURI: event.blockedURI,
                  source: `${event.sourceFile}:${event.lineNumber}`,
                  sample: event.sample,
                }),
            )
          })
        }, prefix)
        return context
      }

      try {
        await useFixture(violations)
      } finally {
        browser.newContext = newContext
        for (const remove of removeListeners) remove()
        expect(
          violations,
          `CSP 违规：\n${violations.map((violation) => JSON.stringify(violation)).join('\n')}`,
        ).toEqual([])
      }
    },
    { auto: true },
  ],
})
