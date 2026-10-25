# ADR-0010 插件 API：声明式定义、六类扩展点、能力授权、独立版本

- 状态：已采纳（S5 已通过，见 `spikes/s5-remote-kysely/README.md`；"后果"中遗留的两个 SQLite 风险已由 S2 给出方案，见 ADR-0008；第一版的公开面和插件事务由 ADR-0033 补充；第三方登录合并成一个插件一条已被 ADR-0034 取代；插件 API 的版本怎么算、哪些变化算破坏性由 ADR-0035 补充；google-adsense、gtag-js 改成的"统计/广告脚本"由 ADR-0063 落地为页头代码）
- 日期：2026-10-16

## 背景

BS 每次大版本升级，插件都大面积失效；`guide/conflicts.md` 里记录的执行顺序问题也一直没有解决。根源在于插件直接依赖内部实现：Eloquent 模型、Twig 视图、可以拦截任何数据的 Filter、往页面里注入任意 HTML/JS。

## 决定

接口草案见 `packages/plugin-sdk/`，示例插件见其中的 `examples/`。

1. **插件只通过逐个列出、各自带版本的扩展点，以及 SDK 提供的数据对象（DTO）接触核心，永远看不到表结构和内部模型。**
2. **插件用一个声明式对象定义**（`definePlugin({...})`），而不是在运行时调用 `ctx.on(...)` 注册。构建工具不执行任何业务逻辑，就能把插件"会做什么"提取成 `manifest.json`。安装前展示、校验、检测冲突、自动生成设置页，都基于这个文件。
3. **六类扩展点**：
   - **Event**：事务提交后经 outbox 投递，至少投递一次，不能改变结果；
   - **Interceptor**：操作发生前同步调用，只能拒绝或修改白名单里的字段。失败策略、超时、是否在事务内执行，都由核心为每个拦截点单独规定；在事务内执行的拦截器，通过 `ctx.db` 做的写入随核心事务一起提交或回滚；
   - **Provider**：实现核心定义的接口，包括密码哈希、第三方登录、验证码、邮件通道；
   - **Route**：挂在 `/plugins/{id}/*` 下；
   - **UI**：见 ADR-0011；
   - **Data/Job**：KV 存储、插件自有表、后台任务、定时任务。
4. **能力授权**：插件需要申请数据访问能力（`users.read`、`storage.tables` 等）。没申请的能力在类型上就不存在，运行时核心也会拒绝。从贡献清单就能看出来的权限（注册了哪些路由、订阅了哪些事件）不需要再申请。
5. **插件自有表**：插件在 host 中得到一个 Kysely 实例，它的驱动不连接数据库，而是把编译后的操作节点树发给核心。核心按白名单**重建**这棵树（不是"检查"），只允许本插件声明过的表，拒绝原始 SQL；把名字映射成物理名，然后用自己的方言编译器**重新编译**再执行，不信任插件传来的 SQL 字符串。S5 确定的规则：
   - 插件 id 为 `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`；表名、索引名、约束名为 `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`；物理名为 `p_<id，连字符换成下划线>__<名字>`，不超过 63 字符。这样不同插件的物理名不可能冲突，SQLite 表名不区分大小写也不会导致碰撞；
   - 只能有一个 FROM 项，多表用带 ON 的 JOIN（最多 4 个）；不支持 INSERT…SELECT、CTE、窗口函数；RETURNING 只能用在 INSERT 上；
   - 运算符、函数、聚合、数据类型、外键动作走白名单；外键只能指向本插件自己的表；
   - 参数里的日期一律用 ISO 字符串，不接受 `Date`；参数大小、节点数、深度、列表长度、结果行数都有上限；
   - DDL 只能在迁移调用里执行；是否加入核心事务由核心为每次调用登记，不信任插件声明；
   - 插件自己开的事务有并发上限和时限，过期自动回滚，过期后的提交被拒绝。
6. **独立版本号**：插件 API 有自己的语义化版本，与核心版本无关。公开面用 api-extractor 生成报告，CI 中比对差异；任何变化都必须附 changeset；废弃的接口至少保留一个大版本。
7. **官方插件尽量用同一套 API 编写**。某个官方插件写不出来的地方，说明 API 本身需要补充。

## 后果

- 核心可以自由重构 schema，只要 DTO 和扩展点契约不变，插件就不受影响。
- 新增拦截点必须经过设计，不能随手加。这会让少数高度定制的旧插件无法迁移，这是有意为之的取舍。
- 迁移指南写成"旧 Hook/Event/Filter → 新扩展点"的对照表，配上迁移前后的参考插件。社区插件的迁移大概率会由 agent 完成，对照表和示例就是它们的输入。
- 插件查询每条多约 0.4–0.5 ms（IPC、重建、重新编译），不适合在热路径上逐行查询。
- **SQLite 模式下的两个遗留风险，上线前必须解决**：
  - node:sqlite 是同步的，插件的昂贵查询会阻塞整个核心的事件循环。方向：插件查询改在 worker 线程里的独立连接执行；
  - SQLite 只有一个连接，插件开着的事务会让核心所有数据库操作排队。方向：SQLite 模式下极短的事务时限，或者不给插件开事务，只保留加入核心事务。
- PostgreSQL 和 MySQL 需要补上语句级超时；结果行数上限需要下推成 LIMIT；host 与核心之间的 IPC 消息需要大小上限。

## 官方插件的去向

| 去向 | 插件 |
|---|---|
| 做进核心 | yggdrasil-api、yggdrasil-connect、usm-api、legacy-api、config-generator、204-for-unexisted-players、insane-profile-cache、password-algorithm-transition、disable-registration、restricted-email-domains、single-player-limit、texture-description、gravatar、trust-proxies、remote-addr、predis、batch-import（并入导入器） |
| 被 S3 兼容存储驱动取代 | textures-aliyun-oss、textures-qcloud-cos、textures-qiniu-storage |
| 作为参考插件迁移 | invitation-codes（拦截器 + 表单字段 + 自有表 + 后台页）；oauth 及 oauth-github/google/microsoft-live/littleskin（合并为一个第三方登录插件，演示 Provider）；mojang-verification；authme-integration、forum-integration（演示密码 Provider 与访问外部数据源）；refresh-ali-cdn、refresh-qcloud-cdn、purge-azure-global-cdn（最简单的 Event 示例） |
| 不迁移 | hello-dolly、pray-for-kyoto-animation、eruda、hitokoto 等；google-adsense、gtag-js 改为核心中受管控的"统计/广告脚本"设置项 |

## 考虑过的其他方案

- **保留通用 Filter（WordPress 式）**：灵活，但正是插件冲突和升级失效的根源。
- **插件通过 `ctx.on()` 等方法动态注册**：写起来灵活，但必须执行插件代码才能知道它会做什么。
