// 给用户设新密码，超级管理员丢了密码或者账号失控时用它找回：后台动不了超级管理员（ADR-0036"命令行"）。
//   pnpm set-password <邮箱或 uid> [--remove-other-methods] [--email <新地址>]
// 读和 `pnpm dev` 相同的环境变量（packages/domain/src/bootstrap.ts），工作目录是 apps/web。
// 新密码在终端里输入两次、不回显，不接受参数里的密码：参数会留在 shell 历史和进程列表里。
// 效果同后台的改密码和收回账号，在一个事务里做完：作废全部网页和启动器登录、还没用的找回链接和改邮箱链接；
// --remove-other-methods 删掉全部通行密钥、解绑全部第三方账号；--email 把邮箱立即换成新地址，算已验证。
// 攻击者多半把邮箱换成了自己的，所以也能按 uid 找人。操作者是 system：不受身份规则限制，照样写审计记录，IP 为空
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import { coreConfigFromEnv, DomainError, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, openCore } from '@nextskin/domain'
import { officialPlugins } from '../lib/official-plugins.ts'

const USAGE = `用法：pnpm set-password <邮箱或 uid> [--remove-other-methods] [--email <新地址>]

  --remove-other-methods  同时删掉全部通行密钥、解绑全部第三方账号，只留下这个密码
  --email <新地址>        同时把邮箱立即换成新地址（算已验证，不发确认链接）

新密码在终端里输入两次，不回显。`

class Cancelled extends Error {}

/**
 * 在终端里读两次密码，不回显。readline 接管终端（raw 模式，终端自己不再回显），
 * 它要回显的内容写进一个什么都不留的流；提示语直接写到 stderr。不留输入历史
 */
async function promptPasswordTwice(): Promise<[string, string]> {
  const discard = new Writable({ write: (_chunk, _encoding, done) => done() })
  const rl = createInterface({ input: process.stdin, output: discard, terminal: true, historySize: 0 })
  // raw 模式下 Ctrl+C 不会变成进程的 SIGINT，由 readline 转给这里
  rl.on('SIGINT', () => rl.close())
  const ask = (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      process.stderr.write(prompt)
      const onClose = () => {
        process.stderr.write('\n')
        reject(new Cancelled())
      }
      // Ctrl+C、Ctrl+D 都会关掉 readline
      rl.once('close', onClose)
      rl.question('', (answer) => {
        rl.off('close', onClose)
        process.stderr.write('\n')
        resolve(answer)
      })
    })
  try {
    const first = await ask('新密码：')
    const second = await ask('再输入一次：')
    return [first, second]
  } finally {
    rl.close()
  }
}

function parse(argv: string[]) {
  try {
    const { values, positionals } = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : argv,
      options: {
        'remove-other-methods': { type: 'boolean', default: false },
        email: { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    })
    const [target, ...extra] = positionals
    if (!target || extra.length) return null
    return { target, removeOtherMethods: values['remove-other-methods'], newEmail: values.email }
  } catch {
    // parseArgs 的消息带着参数的原值，有人可能把密码写进了参数，不能回显
    return null
  }
}

// 只回显已知的领域错误，不回显配置和数据库的报错原文：里面可能有连接串（不变量 11）
function describeError(error: unknown, withNewEmail: boolean): string {
  if (!(error instanceof DomainError)) return '设置密码失败，请检查环境变量和数据库是否可用。'
  switch (error.code) {
    case 'user_not_found':
      return '没有找到这个用户：检查 UID 或邮箱。'
    case 'email_invalid':
      return withNewEmail ? '邮箱的格式不对：检查要找的用户和 --email 的新地址。' : '邮箱的格式不对。'
    case 'email_unchanged':
      return '--email 的新地址和对方现在的邮箱相同。'
    case 'email_taken':
      return '--email 的新地址已经被别的账号使用。'
    case 'password_too_short':
    case 'password_too_long':
      return `密码要有 ${MIN_PASSWORD_LENGTH} 到 ${MAX_PASSWORD_LENGTH} 个字符。`
    default:
      return '设置密码失败，请检查环境变量和数据库是否可用。'
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parse(argv)
  if (!args) {
    console.error(USAGE)
    return 1
  }
  if (!process.stdin.isTTY) {
    console.error('要在终端里运行：新密码只能在终端里输入，不接受管道和参数。')
    return 1
  }

  // 先读密码再连数据库：等人输入的时候不占着连接
  let password: string
  try {
    const [first, second] = await promptPasswordTwice()
    if (first !== second) {
      console.error('两次输入的密码不一致，没有改动。')
      return 1
    }
    password = first
  } catch (error) {
    console.error(error instanceof Cancelled ? '已取消，没有改动。' : '读取密码失败，没有改动。')
    return 1
  }
  // 和领域层同样按 length 数（同 Better Auth），省得连上数据库才发现
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    console.error(`密码要有 ${MIN_PASSWORD_LENGTH} 到 ${MAX_PASSWORD_LENGTH} 个字符，没有改动。`)
    return 1
  }

  try {
    const config = coreConfigFromEnv(process.env, {
      cwd: process.cwd(),
      production: process.env.NODE_ENV === 'production',
    })
    // 带上官方插件：通知邮件里解绑的第三方账号要按插件的文案写出名称，用例发出的事件也要展开给启用的官方插件
    const opened = await openCore(config, { startJobs: false, officialPlugins })
    try {
      const result = await opened.core.admin.setPasswordAsSystem(args.target, {
        password,
        removeOtherMethods: args.removeOtherMethods,
        newEmail: args.newEmail,
      })
      console.log(
        `已为 ${result.nickname}（UID ${result.uid}）设置新密码，退出了 ${result.revokedSessions} 个网页登录、` +
          `${result.revokedTokens} 个启动器登录。`,
      )
      if (args.removeOtherMethods) console.log('对方的通行密钥已全部删除，第三方账号已全部解绑。')
      if (args.newEmail !== undefined) console.log('对方的邮箱已换成 --email 的新地址，算已验证。')
    } finally {
      await opened.close()
    }
    return 0
  } catch (error) {
    console.error(describeError(error, args.newEmail !== undefined))
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
