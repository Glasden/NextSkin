# ADR-0046 拦截点 `user.action`：用户管理角色、材质、OAuth 应用和举报之前调用插件；范围与"要求验证邮箱"一致，失败时拒绝，不在事务内

- 状态：已采纳
- 日期：2026-10-21
- 补充 ADR-0033："推迟"表里的拦截点再多一个；草案的 `player.create`、`player.rename`、`texture.upload` 不按草案做，见"考虑过的其他方案"
- 补充 ADR-0045：同一个站点的另一半需求

## 背景

ADR-0045 的那个站点，旧的做法是外部服务直接写 BS 库：借用 `users.verified` 记"已绑定"，再打开"要求验证邮箱"挡住没绑定的账号。BS 的 `verified` 中间件管的不只是外置登录，还有网页上的这些操作（BS 6 的 `routes/web.php`）：

- 角色：添加、改名、换材质、清材质、删除；
- 材质：上传、改类型、改名、改公开、删除；
- 举报；
- OAuth 应用的管理页。

衣柜不受限制。

迁移到 NextSkin 后，导入器把 `verified` 导成"邮箱已验证"，站长要关掉"要求验证邮箱"：否则用户用验证码绑定之后仍被邮箱验证挡着，而这个标记也不该当作真的邮箱验证交给第三方应用。关掉之后，外置登录由 `yggdrasil.issueToken` 管，网页上的这些限制就没有了。站长要保留它们。

NextSkin 的"要求验证邮箱"在领域层的检查点（`assertPlayerManagementAllowed`）和 BS 的范围一一对应，只多了 Connect 的设备码确认和授权同意。

## 决定

### 拦截点

```ts
/** 次版本可能加成员 */
type UserAction =
  | 'player.create'
  | 'player.update'
  | 'player.delete'
  | 'texture.upload'
  | 'texture.update'
  | 'texture.delete'
  | 'report.create'
  | 'oauthClient.create'
  | 'oauthClient.update'
  | 'oauthClient.resetSecret'
  | 'oauthClient.delete'
  | (string & {})

'user.action': {
  input: { uid: Uid; action: UserAction }
  patch: never
}
```

策略：`{ onFailure: 'closed', timeoutMs: 2000, transactional: false }`，和 `yggdrasil.issueToken` 一样。

- **一个拦截点，`action` 区分操作**：用得到它的插件（这里是"没绑定就不让做"）对所有操作是同一个判断；按操作分开的话要写十一个一样的处理函数，核心以后加一种受限的操作，插件不跟着升级就漏过去。需要区分的插件看 `action`。
- **不在事务内**：完整的 `ctx`，可以访问外部服务。用例的事务在拦截器放行之后才开始。
- **失败时拒绝**：这是做限制的拦截点，出错就放行等于没装。熔断沿用 ADR-0033。
- **`scope`**：`actor` 是这个用户（带 uid 和身份），`locale` 是用户的界面语言、没有就用站点默认语言。领域用例拿不到客户端 IP，`ip` 是空串。
- **input 只有 uid 和 action**：目标的角色、材质由插件按能力自己读；以后需要时加可选字段，是次版本。

### 在哪里调用

就是核心检查"要求验证邮箱"的那些领域用例，调用方是用户本人：

| action | 用例 |
|---|---|
| `player.create` | 添加角色 |
| `player.update` | 改名、换材质、清材质；启动器经 Yggdrasil 上传、重置材质时也走它 |
| `player.delete` | 删除角色 |
| `texture.upload` | 上传材质，网页和启动器（ADR-0037）都算 |
| `texture.update` | 改名、改类型、改公开、改描述 |
| `texture.delete` | 删除材质 |
| `report.create` | 举报 |
| `oauthClient.*` | 用户自己建、改、重置密钥、删除 OAuth 应用 |

- **时机**：事务之前；用例原来在事务外做的校验（例如上传的名字和描述）在它前面，原来在事务里做的校验不挪出来，ADR-0043 定的检查顺序（封禁和邮箱验证、上限、名字和积分）不变，插件的拒绝和邮箱验证同一级。上传在处理图片之前调用，被拒绝时不白做解码和重编码。
- **封禁的用户、不存在的用户不调用**：核心读用户时发现封禁或不存在，不调用插件，按这次读到的状态直接报 `user_banned`、`unauthenticated`，拒绝原因的优先级和以前一样。不能放行、交给事务里原有的检查：读完之后被解封的用户既没经过插件，又能通过检查。
- **不调用**：
  - 衣柜：BS 不限制，"要求验证邮箱"也只查封禁。
  - Connect 的设备码确认和授权同意：带 Join 的令牌由 `yggdrasil.issueToken` 管；其余 scope 不是"管理角色和材质"。
  - 管理员在后台代用户操作、注册时顺带建的角色（注册由 `user.register` 管）。
- 以后核心新增受"要求验证邮箱"限制的操作，同时调用这个拦截点、给 `action` 加成员。

### 拒绝时的响应

- REST：403，错误码 `action_denied`，`message` 是插件给的文案（截到 200 字符），另带 `plugin`、`reason`，和 `registration_denied` 一样。插件不可用时是已有的 `plugin_unavailable`（503，"站点的插件暂时出了问题……"）。
- 启动器上传、重置材质的 Yggdrasil 端点：`ForbiddenOperationException`、403，`errorMessage` 分别是插件的文案和 `plugin_unavailable` 的文案。
- 网页上，受"要求验证邮箱"限制的页面会预先显示提示、禁用按钮；插件的限制在提交时才知道，用户看到的是操作失败的提示。预先提示要插件提供状态，以后需要再加。

### SDK、后台和文档

- `interceptors.ts`：类型（导出 `UserAction`）和 `interceptorPolicies`；`type-tests`：`ctx` 有 `fetch`、`kv`，返回 patch 编译失败，`action` 能和字面量比较；
- 作者文档 `interceptors.md` 加一节；changeset：两个包都是次版本；
- 后台插件详情和安装确认里，这个拦截点显示成"管理角色和材质：可以拒绝"。

### 测试

- 每个调用点：拒绝时用例不执行、没有写入，响应是上面的样子；超时、抛错、host 不可用都拒绝；`action`、`scope` 的值；
- 封禁的用户不调用插件、仍报 `user_banned`；读到封禁之后、事务之前被解封，仍然拒绝；
- 上传被拒绝时不处理图片；启动器上传被拒绝时的 Yggdrasil 错误；
- 衣柜、设备码确认、后台代操作不调用。

## 后果

- 有插件拦截时，这些操作各多一次跨进程调用；没有插件拦截时，只多读一次用户的身份和语言。
- 插件挂了，全站的这些操作都停下；浏览、衣柜、网页登录不受影响。
- 插件的限制没有预先提示，用户要到提交时才知道。
- 启动器上传材质是两个操作：先上传（`texture.upload`），再给角色换上（`player.update`）。插件只拒绝后者时，材质、自动加进衣柜的一项和扣掉的积分都留下，角色的材质不变；两个 action 分别判断，整次请求不是原子的。

## 考虑过的其他方案

- **照草案按操作分成 `player.create`、`player.rename`、`texture.upload` 等**：见上面"一个拦截点"一条。草案的这些点还要改字段（`texture.upload` 改名字和公开）、在事务内调用，都是另一类需求，以后有插件需要时另加，和这个点不冲突。
- **让插件写"邮箱已验证"或者用户的某个限制标记**：插件不写核心数据（ADR-0033、0041）；借用邮箱验证正是旧站要去掉的做法。
- **失败时放行**：上传一张材质的危害不大，但做限制的插件出错就放行，站长以为限制还在。和 `yggdrasil.issueToken` 一样失败时拒绝。
- **在 REST 中间件里按路由拦**：一个用例有网页和启动器两个入口（上传材质），按路由拦会漏；领域用例是唯一的写入口（不变量 4）。
