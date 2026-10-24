import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('首次使用才按环境创建 manager logger，复用实例并按级别分流终端', async () => {
  vi.resetModules()
  vi.stubEnv('NEXTSKIN_LOG_LEVEL', 'debug')
  vi.stubEnv('NEXTSKIN_LOG_FORMAT', 'json')
  const { managerLogger } = await import('./log.ts')
  vi.stubEnv('NEXTSKIN_LOG_LEVEL', 'info')
  vi.stubEnv('NEXTSKIN_LOG_FORMAT', 'text')
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const logger = managerLogger()
  expect(managerLogger()).toBe(logger)
  logger.debug('调试')
  logger.info('正常进展')
  logger.warn('稍后再试')
  logger.error('无法继续')
  expect(stdout).toHaveBeenCalledTimes(1)
  expect(stdout.mock.calls[0]![0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO {2}manager 正常进展\n$/)
  expect(stderr).toHaveBeenCalledTimes(2)
  expect(stderr.mock.calls[0]![0]).toMatch(/ WARN {2}manager 稍后再试\n$/)
  expect(stderr.mock.calls[1]![0]).toMatch(/ ERROR manager 无法继续\n$/)
})
