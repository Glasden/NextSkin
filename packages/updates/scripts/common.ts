import { RELEASE_KEYS } from '../src/index.ts'
import { keyIdPattern } from '../src/versions.ts'

export class ScriptError extends Error {}

export function releaseKeys(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const json = env.NEXTSKIN_RELEASE_KEYS_JSON
  if (json === undefined) return RELEASE_KEYS
  try {
    const value: unknown = JSON.parse(json)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
    if (!Object.entries(value).every(([key, pem]) => keyIdPattern.test(key) && typeof pem === 'string')) {
      throw new Error()
    }
    return value as Record<string, string>
  } catch {
    throw new ScriptError('NEXTSKIN_RELEASE_KEYS_JSON 必须是 key id 到公钥 PEM 的 JSON 对象')
  }
}

export function runCli(main: () => void | Promise<void>): void {
  void Promise.resolve()
    .then(main)
    .catch((error: unknown) => {
      // 底层异常可能夹带输入，命令行只输出自己定义的错误和系统错误码，避免密钥流入 CI 日志
      const code =
        error instanceof Error && 'code' in error && typeof error.code === 'string' ? `（${error.code}）` : ''
      console.error(
        error instanceof ScriptError ? error.message : `发布脚本执行失败${code}，请检查文件、密钥格式和目录权限`,
      )
      process.exitCode = 1
    })
}
