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
  - 角色数量上限（ADR-0043）：设置项 `player.maxPerUser`（0 不限），只管身份低于管理员的用户；用户中心添加和后台转让都在锁住主人之后检查，调低后已有的角色保留；角色页显示"已有 / 上限"，到上限时禁用添加。
- **个人资料和账号安全**（ADR-0023、ADR-0024）：改昵称和语言、改邮箱、删除账号、两步验证、通行密钥。核对密码的 REST 接口按用户限流。
- **材质上传和皮肤库**（ADR-0025）：纯 JS 的 PNG 解码、图像 worker 池、出图端点 `/render/…`（皮肤是 3D 出图，悬浮时抬手，ADR-0048）；上传和上传者的管理；皮肤库和详情页（3D 预览）；用延迟任务推进的文件回收。
- **衣柜、换材质和举报**（ADR-0026）：衣柜页和 `GET /api/closet`、给角色换材质、头像；提交举报和"我的举报"。
- **后台**（ADR-0027）：固定角色映射到具名权限（`can()`）、审计日志、处理举报、管理员删除材质、封禁和任免管理员。
  - 用户详情页和账号操作（ADR-0036 切片一）：改昵称、改邮箱（配置了邮件时发确认链接）、标记邮箱验证状态、改密码和收回账号、关两步验证、删通行密钥、替用户解绑第三方账号、退出全部登录（作废在途的登录）、改积分、删除用户（可连公开材质一起删）；只能管理身份比自己低的用户；修改账号时给用户发通知；邮箱改动生效时作废找回密码链接；命令行的 `set-password`、`disable-2fa`。
  - 角色页（ADR-0036 切片二）：`/admin/players` 按角色名或 UUID 查找、按主人筛选；改名、换材质（材质要对主人可见，不要求在衣柜里）、转让（`score_paid` 清零不退，清掉新主人看不到的材质，删掉绑定这个角色的启动器令牌和设备授权的选择）、删除（不退积分）；SDK 新增事件 `player.transferred`，cdn-refresh 订阅它；启动器刷新令牌在锁内核对角色的主人。
  - 别人的材质和衣柜（ADR-0036 切片三）：有 `textures.manage` 的人在皮肤库详情页、`?uploader=` 和 `?uploader=gone` 里看得到别人的私有材质；皮肤库详情页的管理面板改名、改模型、改描述（上传者已注销的也能改），下架别人的公开材质（不动上传者的积分和 `score_paid`，别人的衣柜按实付退）；用户详情页的衣柜节列出全部衣柜项，按 tid 加入（不扣分）、移出（按实付退）；举报页链接私有材质；删除材质的确认框按 `score.refundOnDelete` 写。
- **失败任务页**（ADR-0051）：`/admin/failed-jobs` 列出核心任务（`core:`）的死信，新权限 `jobs.manage` 只给超级管理员；邮件写模板、收件地址和收件人，其余任务显示载荷，错误码写成说明；单条重试、删除，全部重试、全部删除只处理页面打开时已有的（`through`）；去掉了链接的邮件和没有处理函数的任务不能重试（`JobHandler.retryable`），通知邮件进死信时保留渲染要用的内容；邮件失败记 SMTP 的类别码和应答码（`smtp:EAUTH:535`）；审计 `job.deadLetter`；后台概览提示失败的任务数。插件任务的死信仍在插件详情页。
- **通知**（ADR-0052）：`notifications`、`notification_broadcasts`、`plugin_notification_keys` 三张表。页头的铃铛（未读数数到 100、写 99+，组件 Popover 列最近 5 条未读，点一条标为已读再跳过去；换页面、窗口获得焦点时再取一次）；用户中心的"通知"页（全部、未读，每页 20 条，标为已读、删除、全部标为已读带 `through`）。系统通知和业务写入同一个事务、按收件人的语言渲染：举报的结果告诉举报人，新举报告诉审核人（还有未读的就不再写），管理员下架或删除材质告诉上传者，修改账号、角色、OAuth 应用的每一处另发站内通知（配没配邮件都发）。后台的"通知"页和新权限 `notifications.send`：收件人四选一（全部、普通用户、管理员、最多 50 个指定用户），旁边预览收件人看到的样子，群发先确认；群发由 `core:notification-fanout` 按 uid 每批 500 人展开，撤回当场生效、由 `core:notification-recall` 分批删除；发送记录和审计 `notification.send`、`notification.recall`；用户详情页的"发通知"。保留期 `notifications.retentionDays`（默认 365 天）由每天的 `core:notification-sweep` 清理。插件能力 `notifications.send`（`ctx.notifications.send`）：插件的文案键加参数、站内链接，永久幂等键另存一张表，按高风险展示，卸载时删掉它发的通知，随 `1.0.0-rc.4` 发布。不导入 BS 的通知。浮层（菜单、选择框、弹出层、提示）的层级挪到吸顶的页头之上，窄屏的页头不再盖住从它打开的菜单。
- **设置页**（ADR-0028）：表单由设置注册表生成，只有超级管理员能改；公告和内容政策（Markdown，不渲染原始 HTML）、生成签名密钥、测试邮件。
- **手动维护模式**（ADR-0044）：设置分区"维护"（开关、同时停用游戏服务、维护说明）；路径分类在 `packages/api/src/maintenance.ts`（始终开放、游戏服务、其余），Hono 的中间件和 `proxy.ts` 共用，其余的只放行管理员的会话，挡住的接口返回 503 `site_maintenance`；维护页的手动维护内容（站长的说明、游戏里受不受影响、管理员登录、退出登录）；管理员在页头下方看到提示（组件 Notice）；命令行 `maintenance [on|off]`。和导入的维护模式互不影响。
- **定时任务**（ADR-0029）：`job_schedules` 和调度器（cron 按站点时区解释，用 croner）；清理过期的认证数据、按保留期清理审计日志、回收材质存储里的孤儿文件和临时文件。
- **BS 导入器和安装向导**（ADR-0031）：
  - 导入引擎（`packages/importer`）、`import_runs`、对账报告和命令行；网页登录核对旧格式的哈希时接受 trim 之前的密码；录制环境上的导入回放检查。
  - 安装向导 `/setup`（安装码、"新站"、从 BS 导入）、后台的"数据迁移"、导入期间的维护模式（页面换成维护页，接口返回 503，任务和定时任务暂停）。
- **亮暗模式**（DESIGN.md §10）：页头、认证页和安装向导右上角的菜单（跟随系统、亮色、暗色），偏好按设备记在 Cookie 里；根布局的内联脚本在第一次绘制之前设好 `data-theme`，跟随系统时随系统切换；组件 `MenuRadioGroup`。
- **首页**（ADR-0032）：领奖台（最近 7 天新加进衣柜最多的三个皮肤）、站点统计、最新上传、外置登录三步；全站页脚；站点描述、关键词和页脚文字三个设置项；标志"折起来的头"，站点图标由 `pnpm design:sync` 从 token 生成。
- **站点外观**（ADR-0042）：站点标志 `site.logo` 和站点图标 `site.favicon`（图标没传时用标志）；设置表单的图片控件（组件 ImageInput，按实际尺寸预览）和上传接口 `POST /api/admin/site-images`（PNG、正方形、边长 16～512，小图按最近邻放大，重新编码，另存白底的一份）；单独的存储 `<数据目录>/site-images` 和 `/site-images/<hash>.png`；每周清理没引用的图（`core:site-image-sweep`）；根布局自己写图标的 `<link>`，默认图标挪到 `apps/web/public/`，`/favicon.ico` 有自定义图标时重定向；页头、页脚、登录注册页和全屏页的标志显示上传的图；页脚 Markdown 里的图片缩到一行字高；导入报告提示重新上传图标。
- **站点的 CSP**（ADR-0053）：页面带 `script-src 'nonce-…' 'strict-dynamic'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`，nonce 由 `proxy.ts` 按请求生成、经请求头交给 Next 和根布局（`lib/csp.ts`），开发模式多 `'unsafe-eval'`；样式、图片、请求、iframe 不约束，不维护来源白名单。亮暗模式的内联脚本带 nonce，Base UI 经 `packages/ui` 的 `CspProvider` 拿到它；全站发 `X-Frame-Options: DENY`；进 Hono 的路径不加。lint `nextskin/no-script-without-nonce`；e2e 的共用 fixture（`e2e/fixtures.ts`）在任何页面出现 CSP 违规时判失败。部署文档写了 CDN（Cloudflare）哪些功能要关。
- **插件系统第一版**（ADR-0033），按 ADR 的三步落地：
  1. 插件在核心进程内运行（`packages/domain/src/plugins/`、`packages/plugin-host`）：能力检查、事件、任务和定时任务、KV、设置；插件自有表经网关查询（重建 SQL，SQLite 用专用的只读连接）；`/plugins/{id}/*` 路由网关；声明式的页面、导航和注册表单字段；`user.register` 拦截器；后台的"插件"页（启用、停用、设置、死信）；官方插件"邀请码"和"CDN 刷新"。
  2. 上传的插件在 plugin host 进程里运行：核心进程拉起；stdin/stdout 上带长度前缀的帧；`--permission`，环境变量为空，Node 26 起不能直接连网；整代切换，新一代报告的定义要和 manifest 一致；崩溃后退避重启，连续崩溃就停下、等管理员在后台重启。`nextskin-plugin build` 打插件包（`packages/plugin-cli`）；后台上传安装、升级（列出新增的能力）、卸载，都写审计；多实例按 `plugins.package_hash` 从存储接口取包。
  3. passwordHasher：核心认不出的哈希按插件的 `detect` 认领、调用插件，网页登录和启动器登录通过后换成当前算法；导入器保留插件格式的哈希；官方插件"AuthMe 密码"；第三方登录见下一条。
- **插件写核心数据**（ADR-0041）：第一项能力 `users.score`（`ctx.users.adjustScore`）：以插件身份改积分，流水记 `plugin_id`、`plugin_key`（两列同空或同不空，`(plugin_id, plugin_key)` 唯一，永久幂等键），同 key 同参数返回 `duplicate`、参数不同拒绝，并发撞上唯一索引回滚后再查；按高风险能力展示；用户中心和后台的积分记录用插件的文案显示原因，卸载之后写"来自插件"；后台插件详情页显示累计加减和最近 10 笔。注册字段的 `fromQuery`：`/sign-up` 用查询参数 `<插件 id>.<字段名>` 预填。官方插件"分享注册链接"（share-registration-link，每个分享人的奖励次数可以设上限），两条加载路径都有端到端测试。
- **第三方登录**（ADR-0034）：一家一个官方插件（`oauth-github`、`oauth-microsoft`、`oauth-google`、`oauth-littleskin`，共用 `packages/oauth-client`）；绑定存在 `accounts`，两个唯一索引；登录页和注册页的按钮、首次登录的"完成注册"页（经过注册用例）、邮箱撞上已有账号时只绑定没有任何登录方式的账号；第三方登录后照样过两步验证；安全页的"第三方账号"（绑定要求刚登录过、解绑保留最后一种登录方式）和"设置密码"，要核对密码的操作提示先设置密码；后台插件详情页的回调地址，卸载时删除绑定。
- **外置登录的拦截点**（ADR-0045）：`yggdrasil.issueToken`，签发能进服的令牌之前调用插件（启动器登录、刷新，Connect 令牌端点带 Join 的三种 grant），失败时拒绝、不在事务内、预算 2 秒；被拒绝时启动器显示插件的文案（403 `ForbiddenOperationException`），Connect 删掉刚签发的令牌、返回 `invalid_grant`；启用着却取不到包的插件让每个失败时拒绝的拦截点都按不可用处理。仓库里用测试插件覆盖。
- **网页上受限操作的拦截点**（ADR-0046）：`user.action`，用户本人建、改、删角色，上传、改、删材质（含启动器上传），举报，管理自己的 OAuth 应用之前调用插件，范围和"要求验证邮箱"一致（衣柜、设备码确认、OAuth 同意不调用）；失败时拒绝、不在事务内、预算 2 秒；封禁的用户不调用插件；被拒绝时 REST 返回 403 `action_denied`、带插件的文案。网页上没有预先提示，要到提交时才知道。
- **插件按昵称搜索用户**（ADR-0050）：`ctx.users.searchByNickname(query, { after?, limit? })`，`users.read`、`users.readPrivate` 都有，返回的 DTO 由能力决定；昵称包含 query（`containsInsensitive`，ASCII 不分大小写，按字面、不 trim，含 NUL 返回空数组），按 uid 往后翻页、每次最多 100 个，不返回总数。随 `1.0.0-rc.3` 发布。
- **启动器**（ADR-0039）：`packages/launcher`，源码里 `pnpm nextskin <命令>`，发行目录里 `node nextskin.mjs <命令>`。`start` 只监管核心进程（plugin host 仍由核心拉起）：崩溃后退避重启，停止时先收任务再关 HTTP（核心一侧在 `apps/web/lib/launcher-channel.ts`，启动器被强制结束时核心自己退出），数据目录加锁防止重复启动，相对路径按根目录解析，缺密钥且没有 `.env` 时生成；`migrate`、`set-role`、`set-password`、`disable-2fa`、`disable-captcha`、`import blessing-skin`（服务运行时拒绝）。命令行连同领域层用 rolldown 打包，`pnpm build` 组装发行目录 `dist/nextskin/` 并检查产物里没有开发数据和 `.env`；官方插件清单挪进 `packages/official-plugins`；e2e 改为从发行目录经启动器启动。`doctor` 只读地逐项检查：Node 和插件能否直接连网、`.env` 和密钥（POSIX 上别人可读时警告）、数据目录可写和剩余空间、数据库连接和迁移状态（库比程序新时失败，MySQL、PostgreSQL 10 秒超时）、plugin host 带 `--permission` 起来并握手、服务是否在运行和健康检查；有失败时退出码 1，`pnpm build` 的冒烟也跑它。
  - 命令行管理插件（ADR-0049）：`plugin list`、`plugin install <插件包> [--yes]`（安装和升级，先打印后台确认框里的内容；第一次安装、升级多了能力或出站地址或高风险项、去掉了登录方式时要确认，卸载总要确认，不在终端里又没有 `--yes` 就拒绝）、`plugin enable|disable <id>`、`plugin uninstall <id> [--yes]`；调用后台的同一组用例的 `…AsSystem` 入口，审计记成 system、没有 IP；能力等名称读 i18n 里后台的文案。服务运行时也能执行：命令行的 host 只用来准备（`pluginHostMode: 'stage'`，启用、升级上传的插件时临时拉起只有它的一代，加载、跑完迁移就杀掉，不运行安装插件、不清理插件目录），运行中的服务按插件表同步后自己换代（e2e 从发行目录对运行中的服务验证）；刚解开的包目录按标记文件的修改时间跨进程地不清理；SQLite 上插件的锁改成库文件旁边 `-locks/` 里的锁文件，跨进程互斥。
- **发布**（ADR-0040）：组装时摊平 `node_modules`（发行目录里没有链接、没有 `.node`），版本号写进发行目录和 `server/VERSION` 并由 `start`、`doctor` 核对，ZIP 里的 README；发布工作流 `.github/workflows/release-site.yml`（推 `v*` 标签：核对、构建、e2e、ZIP、`SHA256SUMS`、Windows 解压冒烟、镜像冒烟，经 `release` 环境推两种架构的 `X.Y.Z` 到 GHCR、建草稿 Release），草稿发布后由 `release-image-tags.yml` 加 `X.Y`、`X`、`latest`。镜像 `packages/launcher/docker/Dockerfile`（tini 做 PID 1，以 uid 1000 运行，`/app` 只读、数据在 `/data`），`smoke.sh` 也在 CI 的 e2e 任务里跑。SQLite 有要执行的迁移时先 `VACUUM INTO` 到 `<数据目录>/backups/`（留最近 3 份），备份失败就不迁移（`openCore` 和 `migrate` 命令共用 `migrateCore`）。部署文档 `docs/deploy/`：公共部分（配置、建站、反向代理和受信任的代理、进程管理、升级和回退）和宝塔、1Panel、Docker（含 `compose.yaml`）、systemd、Windows 各一页，没实测的条目标了"未实测"。第一个版本 0.1.0 已经发布（2026-10-21）：两个发布工作流都跑通了，GHCR 的 `nextskin` 包是公开的（匿名能拉取），`0.1`、`0`、`latest` 指向 `0.1.0`。

## 还没做

- **插件 SDK 1.0**（ADR-0035）：冻结前的调整、打包和发布流程、作者文档（`packages/plugin-sdk/docs/`）已经做完；两个包的 `1.0.0-rc.0` 已经由维护者在本地发到 npm（2026-10-19，预发布模式 `rc`，没有来源证明），仓库已经公开，npm 的可信发布和 GitHub 的 environment `npm`（要维护者批准）已经配好，之后的候选版由 CI 发：`1.0.0-rc.1` 已经由 CI 经可信发布发出（2026-10-21，带来源证明；runner 上没有 git 身份，标签没建出来，是手动补推的，工作流已修）。候选期在仓库外迁 share-registration-link（ADR-0041）：先用 `pnpm pack` 出来的包迁了一遍，构建命令不认 `fromQuery`（已修），作者文档补了辅助函数里 ctx 的类型、类型检查的配置、`site.url` 可能为空；rc.1 发出来之后照入门装 npm 上的 `@rc`，类型检查和构建都通过。`1.0.0-rc.2`（新增拦截点 `yggdrasil.issueToken`、`user.action`，ADR-0045、ADR-0046）已由 CI 发布（2026-10-21）；`1.0.0-rc.3`（新增 `ctx.users.searchByNickname`，ADR-0050）已由 CI 发布（2026-10-22）；`1.0.0-rc.4`（新增能力 `notifications.send`，ADR-0052）推到 main，由 CI 发布。还没做：收集作者意见；退出预发布时去掉 README 和入门里的 `@rc`。
- **第三方登录的字段核对**：四家的 subject、`emailVerified` 还要用真实账号核对一遍（ADR-0034"首批插件"）。
- **插件 API 推迟的部分**：其余写核心数据的能力（以指定 UUID 建角色等，见 ADR-0041 的"以后的写能力"）、草案里的其余五个拦截点、运行时组件和插槽等，见 ADR-0033 的"推迟"表。
- **发布的后续**（ADR-0040）：ZIP 和镜像的构建来源证明（`actions/attest-build-provenance`）可以加了（仓库已公开）；推到 GHCR 的镜像还没在真实环境里运行过（发布工作流的镜像冒烟跑的是 runner 上本地构建的 amd64 镜像）；部署文档里标了"未实测"的条目（宝塔和 1Panel 的反向代理、Windows 的 Ctrl+C 和 NSSM、Docker 里导入）等真实环境核对；国内的下载渠道看 0.1.0 发出后的反馈再定。
- **CSP 的实测**（ADR-0053）：三家验证码各用官方的测试密钥在真实网络上走一遍（hCaptcha 的文档没提 `'strict-dynamic'`）；放在 Cloudflare 后面、开着 Bot Fight Mode 的部署上看控制台有没有 CSP 报错；Cloudflare Web Analytics 的自动注入会不会被拦。
- 后台覆盖翻译、种子数据。
