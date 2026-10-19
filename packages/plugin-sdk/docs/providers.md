# Provider

Provider 由核心在认证流程中调用。迁移旧密码用 `passwordHasher`，接第三方身份用 `login`；你不需要自己建立站点会话或绑定表。

## passwordHasher

`providers.passwordHasher` 是数组，每项有 `id`、`label`、`detect`、`verify`。id 匹配 `^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$`，同一插件内不能重复；label 是文案键。

detect 至少声明 prefix 或 pattern 一项。prefix 是非空字符串组成的数组，按区分大小写的开头匹配；pattern 是正则源码，用 `u` 标志编译，在核心进程执行，不能写会回溯爆炸的表达式。两项都写时任一匹配就算匹配。不要用无范围限制的模式认领其他插件的哈希。

`verify({ password, hash, ctx }): Promise<boolean>` 只核对，不生成哈希。只有既不是核心当前算法、也不是核心支持的 BS 旧格式（bcrypt、argon2、BS 摘要等）的哈希才会交给插件，并先经过 detect；超过 512 个 UTF-16 代码单元的 hash 不匹配插件。多个 Provider 匹配时按插件 id、再按数组声明顺序调用，有一个返回 true 就通过。

网页登录、启动器登录和敏感操作前核对密码都经过它。网页登录、启动器登录通过后核心用自己的算法重新哈希并替换；敏感操作核对密码时不换算法。替换是带旧哈希条件的更新，不会覆盖期间已经重设的新密码。按原密码不通过、首尾又有空白时，还会用 trim 后的密码再核对一次，以兼容 BS。

每次 verify 限 5 秒。超时、抛错、非布尔结果都按核对不通过处理；同一 Provider 连续失败 3 次后冷却 30 秒。正常返回 false 是“密码不对”，不算 Provider 故障。参数包含明文密码，不得写日志或异常消息。

典型迁移是：导入器保留外部密码格式，插件按前缀认领，从 hash 本身拆出盐和算法参数，核对后让核心逐个换成当前算法。没有 uid 参数，不能依赖旧用户表里另一列的盐。完整实现见 [authme-password](https://github.com/Glasden/NextSkin/tree/main/plugins/authme-password)，认领 `$SHA$`、`$authme$` 前缀。它只保留旧插件的密码兼容部分，不会连接 AuthMe 数据库。

## login

`providers.login` 同样是数组，每项有 id、label、icon、authorizeUrl、exchange。id 匹配上述 Provider 正则，最多 64 字符。**插件 id 和 Provider id 必须永远对应同一个第三方**：绑定按两者定位，改名会使原绑定对不上，换成另一个第三方会让 subject 撞上旧身份。

label 是第三方名称的文案键，用在登录按钮、安全页和通知邮件。icon 是 pixelarticons 图标名，认不出来显示积木。

| 方法 | 参数 | 返回和期限 |
|---|---|---|
| `authorizeUrl` | `{ state, codeChallenge, redirectUri, ctx }` | 返回 HTTPS 绝对授权地址，5 秒 |
| `exchange` | `{ query, codeVerifier, redirectUri, ctx }` | 返回 `ExternalIdentity`，15 秒 |

state、PKCE 验证器、账号绑定、首次注册、两步验证、会话由核心处理。codeChallenge 始终按 S256 生成；第三方不支持 PKCE 时可不把它发给第三方，仍须传 state。redirectUri 是固定回调地址，站长能在后台插件详情页复制。query 是回调 URL 的全部查询参数记录；回调带 error 参数时核心直接按取消处理，不调用 exchange。两个方法的 `ctx.t` 默认使用请求语言。

exchange 必须返回：

| 字段 | 规则 |
|---|---|
| `subject` | 永远指向同一人的第三方 id。匹配 `^[\x21-\x7e]{1,255}$`：1–255 个可打印 ASCII 字符，不含空格。用数字 id 或 OIDC sub，不用会变的邮箱、登录名 |
| `email` | 字符串或 null。没有就 null，用户在“完成注册”页补填；核心先 trim 并转小写，超过 255 个 UTF-16 代码单元或格式非法时也当作没给 |
| `emailVerified` | 必须是 boolean，仅在第三方确认此人现在拥有此邮箱时为 true，不确定用 false |
| `displayName` | 字符串或 null，只用来预填，不自动改已有用户资料 |

昵称预填先 trim，再按 Unicode 码点截到 255 字符。角色名预填使用 trim 后未截断的名字，必须通过站点长度和浏览器支持的角色名正则；自定义规则只在服务端识别，不预填。最终提交仍走核心校验，预填不等于通过注册。

超时、抛错、返回值不合格使本次登录失败；连续失败 3 次冷却 30 秒。核心不记录 Provider 抛出的消息，但插件自己的日志、未 await 的 Promise 仍可能泄漏授权码、令牌或个人信息，错误消息也要脱敏。

## 绑定和首次登录

绑定的命名空间是 `plugin:<插件id>:<Provider id>`。同一第三方账号只能绑一个本站用户，一个用户在每个 Provider 下只能绑一个第三方账号。插件不能给其他插件的命名空间提供身份，核心不存第三方令牌，exchange 也不返回令牌。

已有绑定直接走登录，开了两步验证仍要第二步。没绑定时：

1. 邮箱已被占用，通常提示用原方式登录再到安全页绑定。唯一例外：该账号已经没有任何可用登录方式，且第三方的 emailVerified 为 true，核心才自动绑定并登录。
2. 需要新建用户时检查注册开关，进入“完成注册”页；不会静默建号。邮箱、角色名、IP 限额、邀请码字段和 `user.register` 拦截器仍生效。
3. 用户可以改邮箱。只有最终邮箱与第三方邮箱转小写后相同、且 emailVerified 为 true，才按已验证处理；否则走核心验证邮件。

用户主动绑定要求刚登录过，解绑不能删掉最后一种可用登录方式。插件停用后按钮消失、绑定保留；卸载则删除它名下的绑定。不要靠停用再换 Provider 含义来迁移第三方。

参考 [oauth-github](https://github.com/Glasden/NextSkin/tree/main/plugins/oauth-github)、[oauth-google](https://github.com/Glasden/NextSkin/tree/main/plugins/oauth-google)、[oauth-microsoft](https://github.com/Glasden/NextSkin/tree/main/plugins/oauth-microsoft)、[oauth-littleskin](https://github.com/Glasden/NextSkin/tree/main/plugins/oauth-littleskin)。它们共用的 `@nextskin/oauth-client` 是仓库内部包，未发布；第三方作者要用自己的 HTTP/OIDC 实现，不能把它写成 npm 依赖。
