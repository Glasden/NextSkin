# 进度

按领域列出已经落地和还没做的部分。为什么这么做看对应的 ADR（`docs/adr/`），这里只记做到了哪里。

切片落地时，在同一个提交里改这份文件：改对应领域的条目，不按时间往后追加；做完的"还没做"挪到"已经落地"。AGENTS.md 的"当前阶段"只留一句正在做什么。

## 已经落地

- **基础设施**（ADR-0013、ADR-0014）：monorepo 骨架、工具链、CI（`.github/workflows/ci.yml`）和 Renovate；核心表的迁移；国际化（ADR-0019）。
- **协议端点**：CSL、USM、Legacy、`/textures`，契约测试（`tests/contract`，支持有状态的场景）。
- **Yggdrasil**（ADR-0030）：元数据和角色查询；authserver 的令牌表和五个端点、进服、启动器上传和删除材质；开了两步验证的账号在密码后面接验证码。仪表盘的外置登录配置，安全页的启动器登录列表。
  - Yggdrasil Connect 的设备码流程（ADR-0037 切片一）：三个 Yggdrasil scope 和组合规则、`selectedProfile`/`availableProfiles` 声明、发现文档（`shared_client_id`）、元数据的 `feature.openid_configuration_url`（https 站点）；迁移插入的公用应用；`/device` 批准页（认领、选角色、批准和拒绝走领域用例，按用户限制猜错代码的次数，防点击劫持的响应头）；`join`、`validate`、`invalidate` 和启动器上传、删除材质认 OAuth 令牌（要 Join，上传只能改绑定的角色）；有效期和每个应用的数量上限取 authserver 的设置；改密码、作废在途的登录、角色转让和删除、删除账号时吊销，签发途中被吊销的令牌签发后立即撤回（`users.oauth_version`）；安全页的"已授权的应用"和取消授权；导入器把 Janus 标记的应用转成公共客户端。
  - Yggdrasil Connect 的授权码流程（ADR-0037 切片二）：授权码流程放开 Yggdrasil scope（组合规则、缺省 scope 按应用登记的补上、去掉 Yggdrasil scope）；`/oauth/consent` 同意页（服务端验签，应用、回调地址的主机、权限，申请 Select 时选角色、经请求头交给 consent 钩子写进同意记录和授权码，换一个账号）；公共客户端和申请 Select 的请求每次都征求同意；登录后续跑（登录页验签后重新打开授权地址，密码、两步验证、通行密钥、第三方登录、注册都经 `next` 回去，已登录、不用重新登录时直接回去），`/oauth2/continue` 关闭，`oauth_query` 只在同意端点上接受；授权错误按登记规则判断回调地址可信时重定向回应用，否则去站内错误页 `/oauth/error`（也是 Better Auth 的 `errorURL`）；被封禁、邮箱没验证时送到同意页说明原因、只能拒绝；不接受只同意一部分 scope；`prompt=create`、`select_account` 当成 login，拒绝 `dpop_jkt` 和 OIDC 的 `claims` 参数；第三方登录出错时把 `next` 带回登录页。
  - Yggdrasil Connect 的应用管理（ADR-0037 切片三）：用户中心的"OAuth 应用"页（网站和启动器两种类型，创建时生成 client_id 和只显示一次的密钥，改名称和回调地址、重置密钥、删除，回调地址照 Better Auth 的规则校验、修改时只校验新加的，页面上给出发现文档的地址）；后台的"OAuth 应用"页和权限 `oauthClients.manage`（查找、按主人筛选，停用、启用、删除，写审计、停用和删除通知主人，没有主人的应用和公用应用只有超级管理员能处理，公用应用不能删）；用户详情页的"已授权的应用"数和名下的应用数。
- **认证和注册**（ADR-0007、ADR-0018）：Better Auth 的表和配置、旧密码兼容、serial 下的能力限制；注册用例和注册规则，注册接口 `POST /api/register` 是第一个 REST 接口（`packages/api/src/rest/`）；登录、注册和找回密码的页面。
  - 验证码（ADR-0038）：设置分区"验证码"选 Turnstile、hCaptcha 或 reCAPTCHA v2（复选框和隐形），注册、密码登录、找回密码每次都要，令牌放在 `X-Captcha-Response`；核对在领域层、由入口调用，核对不了一律拒绝；挂件的外框 `CaptchaFrame`；后台的"测试验证码"和配置检查；命令行 `disable-captcha`；导入 BS 的 reCAPTCHA 设置。
- **邮件**（ADR-0020、ADR-0021）：模板在 `packages/email`，发送是持久的后台任务。
- **事件、后台任务和积分流水**（ADR-0021）：任务表和执行器；事件在业务事务里按订阅者展开成任务；`adjustScore`。
- **用户中心**（ADR-0022）：外壳和导航、仪表盘（积分、签到）、角色管理。写接口认会话 Cookie。
- **个人资料和账号安全**（ADR-0023、ADR-0024）：改昵称和语言、改邮箱、删除账号、两步验证、通行密钥。核对密码的 REST 接口按用户限流。
- **材质上传和皮肤库**（ADR-0025）：纯 JS 的 PNG 解码、图像 worker 池、出图端点 `/render/…`；上传和上传者的管理；皮肤库和详情页（3D 预览）；用延迟任务推进的文件回收。
- **衣柜、换材质和举报**（ADR-0026）：衣柜页和 `GET /api/closet`、给角色换材质、头像；提交举报和"我的举报"。
- **后台**（ADR-0027）：固定角色映射到具名权限（`can()`）、审计日志、处理举报、管理员删除材质、封禁和任免管理员。
  - 用户详情页和账号操作（ADR-0036 切片一）：改昵称、改邮箱（配置了邮件时发确认链接）、标记邮箱验证状态、改密码和收回账号、关两步验证、删通行密钥、替用户解绑第三方账号、退出全部登录（作废在途的登录）、改积分、删除用户（可连公开材质一起删）；只能管理身份比自己低的用户；修改账号时给用户发通知；邮箱改动生效时作废找回密码链接；命令行的 `set-password`、`disable-2fa`。
  - 角色页（ADR-0036 切片二）：`/admin/players` 按角色名或 UUID 查找、按主人筛选；改名、换材质（材质要对主人可见，不要求在衣柜里）、转让（`score_paid` 清零不退，清掉新主人看不到的材质，删掉绑定这个角色的启动器令牌和设备授权的选择）、删除（不退积分）；SDK 新增事件 `player.transferred`，cdn-refresh 订阅它；启动器刷新令牌在锁内核对角色的主人。
  - 别人的材质和衣柜（ADR-0036 切片三）：有 `textures.manage` 的人在皮肤库详情页、`?uploader=` 和 `?uploader=gone` 里看得到别人的私有材质；皮肤库详情页的管理面板改名、改模型、改描述（上传者已注销的也能改），下架别人的公开材质（不动上传者的积分和 `score_paid`，别人的衣柜按实付退）；用户详情页的衣柜节列出全部衣柜项，按 tid 加入（不扣分）、移出（按实付退）；举报页链接私有材质；删除材质的确认框按 `score.refundOnDelete` 写。
- **设置页**（ADR-0028）：表单由设置注册表生成，只有超级管理员能改；公告和内容政策（Markdown，不渲染原始 HTML）、生成签名密钥、测试邮件。
- **定时任务**（ADR-0029）：`job_schedules` 和调度器（cron 按站点时区解释，用 croner）；清理过期的认证数据、按保留期清理审计日志、回收材质存储里的孤儿文件和临时文件。
- **BS 导入器和安装向导**（ADR-0031）：
  - 导入引擎（`packages/importer`）、`import_runs`、对账报告和命令行；网页登录核对旧格式的哈希时接受 trim 之前的密码；录制环境上的导入回放检查。
  - 安装向导 `/setup`（安装码、"新站"、从 BS 导入）、后台的"数据迁移"、导入期间的维护模式（页面换成维护页，接口返回 503，任务和定时任务暂停）。
- **亮暗模式**（DESIGN.md §10）：页头、认证页和安装向导右上角的菜单（跟随系统、亮色、暗色），偏好按设备记在 Cookie 里；根布局的内联脚本在第一次绘制之前设好 `data-theme`，跟随系统时随系统切换；组件 `MenuRadioGroup`。
- **首页**（ADR-0032）：领奖台（最近 7 天新加进衣柜最多的三个皮肤）、站点统计、最新上传、外置登录三步；全站页脚；站点描述、关键词和页脚文字三个设置项；标志"折起来的头"，站点图标由 `pnpm design:sync` 从 token 生成。
- **插件系统第一版**（ADR-0033），按 ADR 的三步落地：
  1. 插件在核心进程内运行（`packages/domain/src/plugins/`、`packages/plugin-host`）：能力检查、事件、任务和定时任务、KV、设置；插件自有表经网关查询（重建 SQL，SQLite 用专用的只读连接）；`/plugins/{id}/*` 路由网关；声明式的页面、导航和注册表单字段；`user.register` 拦截器；后台的"插件"页（启用、停用、设置、死信）；官方插件"邀请码"和"CDN 刷新"。
  2. 上传的插件在 plugin host 进程里运行：核心进程拉起；stdin/stdout 上带长度前缀的帧；`--permission`，环境变量为空，Node 26 起不能直接连网；整代切换，新一代报告的定义要和 manifest 一致；崩溃后退避重启，连续崩溃就停下、等管理员在后台重启。`nextskin-plugin build` 打插件包（`packages/plugin-cli`）；后台上传安装、升级（列出新增的能力）、卸载，都写审计；多实例按 `plugins.package_hash` 从存储接口取包。
  3. passwordHasher：核心认不出的哈希按插件的 `detect` 认领、调用插件，网页登录和启动器登录通过后换成当前算法；导入器保留插件格式的哈希；官方插件"AuthMe 密码"；第三方登录见下一条。
- **第三方登录**（ADR-0034）：一家一个官方插件（`oauth-github`、`oauth-microsoft`、`oauth-google`、`oauth-littleskin`，共用 `packages/oauth-client`）；绑定存在 `accounts`，两个唯一索引；登录页和注册页的按钮、首次登录的"完成注册"页（经过注册用例）、邮箱撞上已有账号时只绑定没有任何登录方式的账号；第三方登录后照样过两步验证；安全页的"第三方账号"（绑定要求刚登录过、解绑保留最后一种登录方式）和"设置密码"，要核对密码的操作提示先设置密码；后台插件详情页的回调地址，卸载时删除绑定。
- **启动器**（ADR-0039 切片一）：`packages/launcher`，源码里 `pnpm nextskin <命令>`，发行目录里 `node nextskin.mjs <命令>`。`start` 只监管核心进程（plugin host 仍由核心拉起）：崩溃后退避重启，停止时先收任务再关 HTTP（核心一侧在 `apps/web/lib/launcher-channel.ts`，启动器被强制结束时核心自己退出），数据目录加锁防止重复启动，相对路径按根目录解析，缺密钥且没有 `.env` 时生成；`migrate`、`set-role`、`set-password`、`disable-2fa`、`disable-captcha`、`import blessing-skin`（服务运行时拒绝）。命令行连同领域层用 rolldown 打包，`pnpm build` 组装发行目录 `dist/nextskin/` 并检查产物里没有开发数据和 `.env`；官方插件清单挪进 `packages/official-plugins`；e2e 改为从发行目录经启动器启动。

## 还没做

- **插件 SDK 1.0**（ADR-0035）：冻结前的调整、打包和发布流程、作者文档（`packages/plugin-sdk/docs/`）已经做完，两个包的版本是 `1.0.0-rc.0`（预发布模式 `rc`）。还没做：第一个候选版由维护者在本地发（`pnpm release`），之后配好 npm 的可信发布，由 CI 发；候选期在仓库外照迁移指南迁一个 BS 社区插件、收集作者意见；1.0.0 之前仓库公开，退出预发布时去掉 README 和入门里的 `@rc`。
- **第三方登录的字段核对**：四家的 subject、`emailVerified` 还要用真实账号核对一遍（ADR-0034"首批插件"）。
- **插件 API 推迟的部分**：写核心数据的能力、其余五个拦截点、运行时组件和插槽等，见 ADR-0033 的"推迟"表。
- **启动器的 `doctor`**（ADR-0039 切片二）：环境自检。
- **发布流程**（ADR-0039 留给另一份 ADR）：版本号、CI 打 ZIP 包和镜像、校验和；standalone 里有 pnpm 的相对符号链接，ZIP 在 Windows 上解压要先处理；镜像的基础镜像、PID 1 和 `stop_grace_period`。宝塔、1Panel 怎么选启动命令要实测。
- 通知、站点的 CSP（根布局里亮暗模式的内联脚本要带 nonce 或 hash）、失败任务的后台页面、后台覆盖翻译、种子数据。
