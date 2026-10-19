# ADR-0025 材质上传和皮肤库：退还当初实付的积分，别人的私有材质当作不存在，文件回收用延迟任务

- 状态：已采纳（管理员查看别人的私有材质、下架别人的材质、修改上传者已注销的材质，以及 `score_paid` 改记实付的存储费，由 ADR-0036 补充）
- 日期：2026-10-18

## 背景

`docs/schema.md` 已经定了 `texture_files`（含认领和回收的流程）、`textures`、`closet_items` 的设计，前两张表随只读协议端点建好了。ADR-0017 定了 2D 正背面的出图方式，渲染代码已经在 `packages/skin` 里，出图地址留到了实现阶段。前几份 ADR 留给材质的事：

- 退还按 ADR-0022 的思路：退当初实付的，不退现价；
- 删除账号时清理衣柜和私有材质（ADR-0023）；
- 插件 SDK 的 `Texture.uploader` 改为可空，`findByHash` 重新定义返回哪一条（ADR-0015）。

衣柜的页面和接口、给角色换材质、头像和举报，见 ADR-0026。

BS 6.0.2 的做法（`SkinlibController`）：

- **上传**：
  - 材质名必填，可以用 `texture_name_regexp` 限制；文件必须是 PNG，不超过 `max_upload_file_size`（默认 1024 KB）；
  - 宽是 64 的倍数、高是 32 的倍数；皮肤宽高比 2:1 或 1:1，Alex 只能 1:1；披风只能 2:1；
  - hash 是文件字节的 sha256。同一个 hash 已经有公开的、或者自己上传的条目，就拒绝，并给出已有的 tid；别人的私有副本不算；
  - 花费 = 文件 KB 数（向上取整）×（公开 `score_per_storage` 默认 1，私有 `private_score_per_storage` 默认 10）+ `score_per_closet_item`（默认 0）− `score_award_per_texture`（默认 0）；
  - 收藏数从 1 开始，材质自动放进上传者的衣柜。
- **改公开或私有**：按现价补差价。改成私有时，从别人的衣柜里移除（按现价退衣柜费），别人的角色上清掉；改成公开时，同一个 hash 已经有公开条目就拒绝。
- **删除**：上传者或管理员。按删除时的单价和当时的公开状态退存储费；公开材质在开着 `take_back_scores_after_deletion` 时收回上传奖励；从别人的衣柜里移除并退衣柜费，所有用到它的角色清掉。
- **改名、改模型**：模型可以在 steve、alex、cape 之间任意改，包括把皮肤改成披风。
- **皮肤库**：按类型筛选，按名字搜索，按上传者筛选，按时间或收藏数排序，每页 20 个。普通用户看到公开材质和自己的私有材质，管理员看到全部。别人的私有材质返回 403 或 404（`status_code_for_private`）。

BS 这里的问题：
- **退还按现价，不按实付**，同 ADR-0022。
- **私有材质也发上传奖励，删除时却只收回公开材质的**：上传私有材质再删掉，每次都能多拿一份奖励。
- **余额检查和扣分之间没有锁**，积分也是先读、再算、再写回，并发上传可以透支。
- **改模型不更新角色的修改时间**：CSL 的 `Last-Modified` 不变，客户端一直用缓存里的旧模型。

## 决定

### 范围

这次做：
- 上传材质；
- 皮肤库：列表、材质详情（3D 预览）；
- 上传者管理自己的材质：改名、改模型、改公开、改描述、删除；
- 2D 正背面和头像的出图端点；
- 文件回收；
- 删除账号时清理衣柜和私有材质。

`closet_items` 这次就建：上传的材质要放进上传者的衣柜，删除和改成私有要清理衣柜，导入的数据里也已经有衣柜。

不做：
- 衣柜的页面和接口、给角色换材质、设头像、举报：见 ADR-0026；
- 管理员管理别人的材质：是管理操作，随第一个管理操作和审计日志一起做。这次管理员和普通用户看到的、能做的一样；
- 首页的领奖台（本周收藏最多），随首页一起做；
- 上传奖励，理由见"积分"；
- 内容政策（`content_policy`），随公告一起做（ADR-0022）；
- S3 存储驱动（ADR-0002 的可选档位）。存储接口这次补上写入和删除，只实现本地磁盘；
- WebP 派生格式（ADR-0008 的可选项）、服务端的 3D 渲染图。

### 页面

- 皮肤库是 `/skinlib`，材质详情是 `/skinlib/{tid}`，上传是 `/skinlib/upload`。BS 的 `/skinlib/show/{tid}` 301 跳到 `/skinlib/{tid}`（ADR-0001）。不用 `/textures/{tid}`：`/textures/{hash}` 是协议端点。
- 皮肤库：
  - 只列公开材质。按类型筛选（全部皮肤、Steve、Alex、披风），按名字搜索，排序可选最新、最热（收藏数），每页 20 个，用 TextureCard 网格；
  - 可以按上传者筛选（`?uploader={uid}`）。筛的是自己时，私有材质也列出来，这就是"我上传的"。BS 把自己的私有材质混在皮肤库里，查询要带 `is_public = 1 or uploader_id = ?`，用不上索引；
  - 已经在自己衣柜里的材质，卡片显示为选中（DESIGN.md §6）。
- 材质详情：
  - 以 3D 预览为视觉中心（DESIGN.md §2），旁边是名字、类型、上传者（头像加昵称；上传者已注销时写"已注销的用户"）、收藏数、尺寸、上传时间和描述；
  - 操作：下载。上传者另有改名、改模型、改公开、改描述、删除。改公开和删除都用确认框写明后果（DESIGN.md §7），例如"改成私有要再付 72 积分，并从 15 个衣柜里移除"。ADR-0026 再加上加入衣柜、设为角色的材质、设为头像、举报；
  - 别人的私有材质与不存在的一样返回 404，同 ADR-0022 的角色。
- 上传页：
  - 选择或拖入文件后，浏览器在本地出预览，并用 `packages/skin` 的 `inferSkinModel` 预选模型。解码用纯 JS 的 PNG 解码器，不用 canvas 的 `getImageData`（见 `packages/skin/AGENTS.md`）。预览解错不影响上传，服务端会重新解码；
  - 填名字（默认取文件名）、类型、是否公开、描述；
  - 显示预计花费。实际按服务端规范化之后的大小扣分，通常比原文件小，所以写"最多"。
- 角色管理（ADR-0022）的展台换成真实的 2D 正面：导入的角色本来就有材质。
- 数据流同 ADR-0022：服务端组件直接调用领域层的查询，客户端组件通过 REST 写入后 `router.refresh()`。

### 接口

新接口都认会话 Cookie（ADR-0022），材质的响应格式与 SDK 的 `Texture` 相同：

| 接口 | 请求 | 成功响应 |
|---|---|---|
| `POST /api/textures` | multipart：`file`、`name`、`type`、`public`、`description?` | 201，`{ texture, charged }` |
| `PATCH /api/textures/{tid}` | `{ name?, type?, public?, description? }` | 200，`{ texture, scoreDelta }` |
| `DELETE /api/textures/{tid}` | — | 200，`{ refunded }` |

- 别人的私有材质与不存在的一样，返回 404 `texture_not_found`。
- 被封禁的用户返回 403 `user_banned`（ADR-0022）。
- 上传接口有自己的请求体上限：`texture.maxFileSizeKb` 加上表单字段的余量，读请求体时就检查，超出返回 413 `texture_file_too_large`。REST 全局的 16 KB 上限不适用于它。
- 上传按用户限流，每分钟 10 次：解码和规范化很耗 CPU。用 ADR-0023 的限流接口。

### 上传

1. HTTP 层检查请求体大小和表单字段；领域用例先检查封禁和邮箱验证（ADR-0018）。这些都不用解码。
2. 在图像 worker 里（ADR-0008）：
   - 按 ADR-0008 把关、解码；
   - 检查尺寸：`packages/skin` 的 `textureScale`，再加两条：Alex 必须是 1:1 的新格式，同 BS；宽（22×17 系列的披风补齐之后）不超过 1024，即 ADR-0008 的解压预算之内。不合规返回 400 `texture_size_invalid`，带上宽高；
   - 规范化，算像素 hash，编码 PNG；
   - 顺便生成常用的出图，预热缓存（ADR-0017）。
3. 调用 `texture.upload` 拦截器（SDK 已定义，不在事务里）。插件运行时落地之前先留好位置。拦截器可以改名字和公开与否，所以花费在它之后计算。
4. 找文件：按像素 hash 找 `active` 的文件行。导入的旧文件可能有好几个像素相同，取 hash 最小的一个，结果稳定。找到就复用，否则按 `docs/schema.md` 认领一个新 hash 并写入存储。遇到别人正在上传同一张图（`pending`），或者正在删除（已经开始删的 `deleting`），等一会儿重试几次，还不行就返回 503 `service_unavailable`。
5. 一个事务里：
   1. 扣积分，同时锁住上传者的行（`docs/schema.md` 的加锁顺序）。不扣分时执行一条不改值的 UPDATE；
   2. 复用时 `ref_count + 1`，新文件按 schema.md 激活。两者都会锁住文件行；
   3. **锁住文件行之后再查重**：像素相同的文件上已经有公开条目，或者有上传者自己的条目（无论公开与否），就拒绝，返回 409 `texture_duplicate`，带上已有的 tid。别人的私有条目不算，也不透露。查重放在锁之后，两个人同时上传同一张图，只有一个能成功；
   4. 插入材质条目，收藏数为 1；放进上传者的衣柜，名字取材质名；
   5. 发 `texture.uploaded`、`closet.itemAdded`。
6. 激活失败（认领已经被别人接手）时从第 4 步重来。事务因为积分不够或查重而回滚时，已经写入的对象不删，等认领的租期到了再回收（见"文件回收"）。

### 修改和删除材质

只有上传者能改、能删，与上传一样要求先验证邮箱（ADR-0018）。上传者已注销的公开材质，这次谁也改不了，等后台。

- **名字**：去掉首尾空白后 1 到 128 个字符（`textures.name` 的宽度）。设了 `texture.nameRegex` 时还要匹配，规则同 `player.nameRegex`。
- **描述**：可以为空，不超过 2000 个字符。按纯文本显示，保留换行，不渲染 Markdown。导入的描述（texture-description 插件写的 Markdown）原样显示。
- **模型**：只能在 Steve 和 Alex 之间改，改成 Alex 仍然要求 1:1。披风不能改，皮肤也不能改成披风。改完一并更新正在用它的角色的 `updated_at`：CSL 的 `Last-Modified` 和 USM 的 `last_update` 都取自这里，不更新的话，客户端会一直用缓存里的旧模型。
- **改成私有**：
  - 按"积分"一节重新计价；
  - 从别人的衣柜里移除，各自按实付退衣柜费（开着 `score.refundOnDelete` 时），收藏数随之减少；
  - 别人的角色上清掉它，别人用它做的头像也清掉。上传者自己的不动。
- **改成公开**：按"积分"一节重新计价。像素相同的文件上已经有别人的公开条目时拒绝，返回 `texture_duplicate`。与上传一样，在锁住文件行之后查。
- **删除**：
  - 所有衣柜里的这一件逐条移除，按各自的实付退衣柜费；
  - 所有角色上清掉它，用它做的头像也清掉；
  - 按实付退存储费（开着 `score.refundOnDelete` 时）；
  - 删除条目，文件的 `ref_count - 1`，减到 0 就开始回收（见"文件回收"）。
- 从角色上清掉材质时，显式更新 `players` 的材质列和 `updated_at`，并发 `player.texturesChanged`。外键的 `set null` 只是兜底：它不更新 `updated_at`，也不发事件。清掉头像同理，发 `user.profileUpdated`（`fields: ['avatar']`）。

### 并发

在 `docs/schema.md` 的加锁顺序上补一条：**依赖材质的存在和可见性的写操作，锁住自己的行之后，再锁住材质的行。**

- 改变材质的存在或可见性的（删除、改公开或私有、改模型）：先锁上传者，再锁材质，然后才动别人的衣柜、角色和头像；
- 依赖材质可见性的（ADR-0026 的加入衣柜、换材质、设头像、举报）：先锁自己，再锁材质并确认它对自己可见。

这样两边在材质行上排队。否则，材质刚改成私有、清完了别人的角色，并发的另一个请求又把它换到了别人的角色上。

改成私有和删除要给很多用户退积分，会依次锁住他们的行，可能和这些用户自己的操作形成死锁。按 uid 升序处理，减少死锁；遇到死锁，整个事务重试（`docs/schema.md`）。

### 积分

新设置项，默认值取 BS：

| 设置 | 默认 | 对应 BS |
|---|---|---|
| `score.perKbPublic` | 1 | `score_per_storage` |
| `score.perKbPrivate` | 10 | `private_score_per_storage` |
| `score.perClosetItem` | 0 | `score_per_closet_item`。上传时自动放进衣柜的那一件也收，同 BS；ADR-0026 的加入衣柜也用它 |

- **存储费** = 文件的 KB 数（字节数除以 1024，向上取整）× 当前可见性的单价：
  - 文件指规范化之后存下的那份；复用已有文件时，就是那个文件的大小。BS 按上传的原文件算，规范化之后通常更小；
  - 复用已有文件照样收存储费：这是按条目收的价，同 BS。
- **实付记在对象的行上，退还按它，不按现价**（ADR-0022）：存储费记在 `textures.score_paid`，衣柜费记在 `closet_items.score_paid`。
- **改公开或私有时，按现价重新计价，多退少补**：新的存储费减去 `score_paid`，正的就扣（余额不够返回 `score_insufficient`），负的就退，然后把 `score_paid` 改成新的存储费。这是换了一种存储，不是删除，所以不看 `score.refundOnDelete`。
- 删除材质、移出衣柜时，开着 `score.refundOnDelete` 才退还，同 BS 的 `return_score`（ADR-0022 已经说明它同时管角色、材质和衣柜）。
- 金额为 0 时不扣分，也不写流水（`adjustScore` 不接受 0）。
- 积分流水的原因各用一个 i18n 键（例如 `score.reasons.textureUploaded`），关联对象写材质。
- **不做上传奖励**（BS 的 `score_award_per_texture`、`take_back_scores_after_deletion`，默认 0）：
  - 奖励必须能收回，否则上传再删除就能无限刷分。BS 的上传奖励在私有材质上就收不回来；
  - 收回时余额可能已经不够。BS 的做法是扣成负数，而我们的 `adjustScore` 不允许负数；后台删除材质也不能因为上传者的余额而失败；
  - 需要时另写 ADR。

### 出图

ADR-0017 把出图地址留到了实现阶段，现在定下来：响应是一年的 `immutable`，地址发出去以后就不好改。

- 2D 正背面：`/render/v{渲染器版本}/figure/{模型}/{k}/{hash}.png`；
- 头像：`/render/v{渲染器版本}/head/{k}/{hash}.png`，即 `packages/skin` 的 `renderHead`，正脸加帽子层。显示为 16、24、32、48px（DESIGN.md §5），k 的选法同 2D 正背面。由 PlayerHead 组件显示，没有头像时显示占位。

两者都照 ADR-0017：hash 格式不对、k 不合法、模型未知时返回 404；生成任务进 worker 池，排队有上限，满了返回 503 并带 `Retry-After`；同一个键的并发请求合并成一个。另外：

- 返回之前确认这个 hash 的文件行是 `active`，缓存里已经有图也要确认。材质删除后，出图跟着 404，与 `/textures/{hash}` 一致；
- 文件回收时，一并删掉这个 hash 的出图缓存；
- 路径加进 `next.config.ts` 的 rewrite，转给 Hono。

### 3D 预览

- SkinViewer 用 skinview3d（ADR-0012），是懒加载的客户端组件，参数照 DESIGN.md §5。
- 不让 skinview3d 自己加载图片：浏览器取回 `/textures/{hash}` 的字节，用上传页的同一个 JS 解码器解码，经 `packages/skin` 的 `prepareSkin` 处理（基础层强制不透明），再画到 canvas 上交给它。canvas 按预乘 alpha 存像素，直接加载 PNG 会丢掉透明像素原有的 RGB，而游戏会把基础层的这些像素显示出来（`packages/skin/AGENTS.md`）。这样 3D 预览与 2D 出图一致。
- 材质放在 S3 或 CDN 上时，取字节要求配 CORS，部署文档要写明（ADR-0017 已经提到）。

### 文件回收

`docs/schema.md` 的流程要有人推进：标记回收、等 D、删对象、等 L、删行、回收过期的认领。`job_schedules` 要等第一个定时任务，这次改用延迟任务（ADR-0021），不需要定时扫描：

- 引用数减到 0 的同一个事务里，把文件行改成 `deleting`，并排一个 D 之后执行的任务，去重键是 hash。从这一刻起 `/textures/{hash}` 返回 404。D 期间有人上传同一张图，按 schema.md 把行改回 `pending`；任务到时发现条件不成立，什么都不做。
- 任务按 schema.md 认领删除、删对象、确认删除，同时删掉这个 hash 的出图缓存。L 大于 0 时，再排一个 L 之后删行的任务；L 等于 0 时直接删行。
- 认领 `pending` 的同一个事务里，排一个租期到期时执行的检查任务。到时还是同一个 `claim_id` 的 `pending`，说明上传中途放弃了或者进程崩溃了，就按上一条回收，并删掉带这个 `claim_id` 的临时文件。
- 取值：认领租期 10 分钟（上传在 worker 里最多几秒）；D 1 小时；L 由存储驱动给出，本地磁盘的删除是同步完成的，L 为 0。S3 驱动落地时，按它的请求超时和重试定 L。
- 存储里有对象、表里却没有行的孤儿，只会来自手工改动存储或程序缺陷。找它们要遍历整个存储，随第一个定时任务做。

### 删除账号

补上 ADR-0023 留下的部分。在锁住用户的行、删除角色之后，删除用户之前：

1. 逐条移出这个用户的衣柜，收藏数减一，不退积分（积分随账号删除），发 `closet.itemRemoved`；
2. 删除这个用户的私有材质，与"删除材质"走同一段逻辑，发 `texture.deleted`。别人的衣柜里本来没有它们，以防万一照样处理；
3. 公开材质留下，`uploader_id` 由外键置空。

### 事件和插件 API

- 事件都在业务事务里发：`texture.uploaded`、`texture.updated`、`texture.deleted`；上传时放进衣柜发 `closet.itemAdded`。因为删除或改成私有而连带移除的衣柜、清掉的角色和头像，逐个发 `closet.itemRemoved`、`player.texturesChanged`、`user.profileUpdated`（`avatar`），actor 是发起操作的用户。
- 拦截器 `texture.upload` 先留好位置，等插件运行时。上传时自动放进衣柜，不经过 `closet.add` 拦截器。
- SDK 要改，按插件 API 变更的流程附 changeset：
  - `Texture.uploader` 改为可空（ADR-0015）；
  - `Texture` 加 `description: string | null`；`texture.updated` 的 `fields` 加 `'description'`；
  - `TexturesApi.findByHash`：同一个 hash 可能有好几个条目（ADR-0015），改为优先返回公开的条目，其次取 tid 最小的；
  - 重写 `texture.deleted` 的 `fileDeleted` 的说明：它表示这个 hash 已经没有任何条目引用，`/textures/{hash}` 立即返回 404，文件随后由后台删除。事件投递时文件多半还在：回收要先等 D（见"文件回收"），D 期间同一张图还可能被重新上传。

### 设置项

除了"积分"一节的，还有：

| 设置 | 默认 | 对应 BS |
|---|---|---|
| `texture.maxFileSizeKb` | 1024 | `max_upload_file_size`。最大 8192：宽高上限内的 PNG 本来就到不了这么大；而且 Next 的 proxy 默认只缓冲 10 MB 的请求体（`proxyClientMaxBodySize`），超出的部分会被截掉 |
| `texture.nameRegex` | 空 | `texture_name_regexp`。导入时去掉 PCRE 的分隔符；带了 JS 不支持的修饰符时，停止并报告 |

不沿用的 BS 设置：

| 设置 | 原因 |
|---|---|
| `score_award_per_texture`、`take_back_scores_after_deletion` | 见"积分" |
| `status_code_for_private` | 别人的私有材质一律返回 404 |
| `auto_del_invalid_texture` | 文件的状态记在 `texture_files` 里，不会出现条目还在、文件没了的情况 |
| `allow_downloading_texture` | 游戏客户端要用 `/textures/{hash}`，它必须公开，藏起下载按钮挡不住任何人 |
| `content_policy` | 随公告一起做 |

导入时，这几项不是默认值的，在对账报告里列出来。

### 组件

新组件写进 `packages/ui`，配 story 和截图基线，并补进 DESIGN.md 的组件清单：
- TextureCard：皮肤库、衣柜里的材质；
- SkinViewer：3D 预览；
- PlayerHead：头像；
- SegmentedControl：皮肤库的类型筛选、排序，上传页的类型；
- Pagination；
- Textarea：描述。

## 后果

- 新迁移：`textures` 加 `score_paid`；建 `closet_items`（带 `score_paid`）；皮肤库的索引按实际的三种查询建（公开材质按类型和时间、按类型和收藏数，按上传者），列的顺序在四种数据库上看过执行计划再定。`docs/schema.md` 已经随采纳更新。
- `packages/db` 补一个不区分大小写的"包含"查询辅助函数，转义 `%` 和 `_`，配四库测试，皮肤库按名字搜索用它。SQLite 的 `lower()` 只处理 ASCII，非 ASCII 字母在 SQLite 上仍然区分大小写，可以接受。
- 新增图像 worker 池，入口照 `AGENTS.md` 的写法（`new Worker(new URL(…))`），搭好后在 `next dev` 和 standalone 产物里都验证一遍（ADR-0008 的后果）。PNG 的把关接入模糊测试（S4 的遗留风险）。
- 浏览器端新增纯 JS 的 PNG 解码器和 skinview3d，都只在上传页、详情页懒加载。
- 删除或改私有一个被大量收藏的材质，是一个很长的事务，在 SQLite 上会一直占着写锁。先接受，测试里量一下一万次收藏的材质要多久；太慢再改成分批执行的后台任务。
- 在四种数据库上做请求级测试：
  - 两个人同时把同一张图上传为公开，只有一个成功；
  - 并发上传不会透支积分；
  - 每次退还都等于实付，调价之后也不变；改公开、改私有多退少补；
  - 改成私有、删除之后，别人的衣柜、角色和头像里都没有它，收藏数对；
  - 文件回收：用可控的时钟走完认领、租期到期、D、删除、删行，以及 D 期间重新上传；
  - 删除账号之后，收藏数、衣柜、材质都对。
- e2e 补上：上传 → 皮肤库里出现 → 详情页的 3D 预览 → 改成私有 → 皮肤库里不见了，别人打开详情页是 404 → 删除。

## 考虑过的其他方案

- **按现价退还（BS 的做法）**、**按积分流水查当初扣了多少**：理由同 ADR-0022。
- **保留上传奖励，收回时扣成负数（BS 的做法）**：`adjustScore` 和 SDK 都承诺不会扣成负数，界面上也得处理负积分。
- **保留上传奖励，收回时最多扣到 0**：先把奖励花掉，收回就落空了，刷分的问题还在。
- **皮肤库里混列自己的私有材质（BS 的做法）**：查询条件带 OR，用不上索引；自己的私有材质在"我上传的"里看更清楚。
- **被别人收藏了就不许改成私有**：别人的衣柜里少了一件确实出人意料，但上传者删除材质的效果一样，拦得住改私有、拦不住删除，没有意义。BS 也允许。
- **定时扫描回收文件**：要等 `job_schedules`，而且大多数时候扫不到东西。延迟任务只在确实有文件要回收时才出现。
- **让 skinview3d 直接加载 PNG**：会丢掉透明像素的 RGB，3D 预览和游戏、和 2D 出图都对不上。
- **描述按 Markdown 渲染（texture-description 插件的做法）**：要引入 Markdown 解析和 HTML 清洗。描述是任何人都能看到的用户内容，清洗出一点错就是 XSS。
