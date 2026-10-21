# 插件表

需要条件更新、索引或查询多行数据时，用 `table()` 声明插件自有表。KV 够用就读[上下文](./context.md)；插件表不能访问核心表，也不能连接外部数据库。

## 声明和迁移

```ts
import { definePlugin, table } from '@nextskin/plugin-sdk'

interface CodeRow {
  code: string
  remaining: number
  created_at: string
}

export default definePlugin({
  capabilities: ['storage.tables'],
  tables: { codes: table<CodeRow>() },
  migrations: {
    '0001_create_codes': {
      async up(db) {
        await db.schema
          .createTable('codes')
          .ifNotExists()
          .addColumn('code', 'varchar(32)', (c) => c.primaryKey())
          .addColumn('remaining', 'integer', (c) => c.notNull().defaultTo(1))
          .addColumn('created_at', 'varchar(32)', (c) => c.notNull())
          .execute()
      },
    },
  },
  jobs: {
    consume: {
      async handler({ payload, ctx }) {
        if (typeof payload !== 'string') throw new Error('invalid code')
        const result = await ctx.db
          .updateTable('codes')
          .set((eb) => ({ remaining: eb('remaining', '-', 1) }))
          .where('code', '=', payload)
          .where('remaining', '>', 0)
          .executeTakeFirstOrThrow()
        ctx.log.info('消费结果', { changed: Number(result.numUpdatedRows) })
      },
    },
  },
})
```

table()只声明行类型，不会建表，也不做运行时行校验。表必须在 tables 中声明；迁移里仍用逻辑名 codes，不要写物理名。

迁移键匹配 `^[A-Za-z0-9_-]{1,128}$`，按键名字典序执行，建议补零前缀 `0001_create_codes`。启用之前执行未完成的 up，每个 up 限 60 秒，成功后记录已执行的键；以后不再执行同名迁移。只向前走，核心不调用 down，不支持降级。不要修改已经发布并执行过的迁移，追加新键。

只有迁移调用提供 schema、允许 DDL；业务 handler 只能 DML。插件不能开事务，包括迁移，每条语句单独提交。迁移中途失败，前面成功的语句可能已经提交，当前迁移名尚未记为完成，下次会从这个 up 开头重跑；要设计可重入步骤并在升级前备份。不要假设整个 up 自动回滚。

## 和核心数据配对的写入

插件表与核心数据不能一起原子提交，插件也不能自己开事务。需要配对时，用核心写能力的永久幂等键分步做（ADR-0041）：

1. 先在自己的表里记一行“待处理”，为这次业务操作选一个稳定且唯一的 id。
2. 用这一行的 id 作 key 调用核心用例，例如调用 `ctx.users.adjustScore`，reason 用本插件的 `score.reward` 文案键，key 用 `reward:<记录 id>`。
3. 得到 applied 或 duplicate 后，把自己的记录标为完成；insufficient、userNotFound 按业务规则保留待处理或标为失败，未知 status 也不要当作完成。

中途失败就找到同一行，用同一个 key、uid、delta 重跑。不要在每次重试时生成新行或新键，也不要用“先查有没有发过、再扣款”的两条语句代替幂等性。核心成功后标记完成之前进程退出，下次会得到 duplicate，不会多记积分。卸载会删除插件表，但核心积分流水和 key 仍保留；重装后生成键时仍需避免与历史业务操作冲突。

键里能放业务上本来唯一的东西时，优先用它，例如新用户的 uid：重装后插件表从头开始，自增 id 会和以前的键撞上，uid 不会。完整例子见 [share-registration-link](https://github.com/Glasden/NextSkin/tree/main/plugins/share-registration-link)：奖励记录先记下分数，事件重投时按记下的分数发；每个分享人的奖励次数用 `(分享人, 第几次)` 的唯一约束挡住并发。

## 名字和隔离

| 对象 | 规则 |
|---|---|
| 插件 id | `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`，manifest 另限 64 字符 |
| 表、索引、约束名 | `^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$` |
| 列名、别名 | `^[A-Za-z_][A-Za-z0-9_]{0,47}$` |
| 物理名 | `p_<插件id，连字符换成下划线>__<对象名>`，最多 63 字符 |

例如插件 invite-codes 的 codes 表映射为 `p_invite_codes__codes`。单连字符、单下划线、小写规则防止插件之间名称碰撞；索引和约束也加前缀。表名越长，留给插件 id 的空间越少。外键只能引用本插件声明的表，不能指向 users、players 等核心表。别名不能与声明表名混淆；不接受 schema 限定名。

## 支持的查询子集

ctx.db 顶层去掉了事务、独占连接、DDL、内省、插件替换、CTE 等入口，**查询构建器和迁移 schema 仍沿用 Kysely 自己的类型**。类型检查通过不代表网关支持，以下范围也是 SDK 契约，之后只放宽、不收紧。超出范围运行时拒绝，并给出原因。

- SELECT 支持选择列、别名、WHERE、AND/OR、括号、带别名子查询、GROUP BY、HAVING、DISTINCT、ORDER BY、LIMIT、OFFSET；一个 FROM 项，最多 4 个带 ON 的 inner/left JOIN。
- 支持参数值、列引用、CASE（最多 32 个 WHEN）、元组（最多 16 项）、下表的函数和聚合。普通函数最多 8 个参数，聚合参数最多 2 项；ORDER BY 最多 8 项，方向只有 asc/desc，可声明 nulls first/last，但实际数据库仍须支持该语法。
- INSERT 只接受 VALUES 或 defaultValues，最多 1000 行；允许 INSERT RETURNING（仍受数据库方言限制）。接受 onConflict、onDuplicateKeyUpdate 和 orIgnore 相应节点，但没有把不同数据库的 upsert 语法自动互译。
- UPDATE、DELETE 支持条件、赋值，以及数据库本身支持的 ORDER BY/LIMIT；不支持 UPDATE/DELETE RETURNING。
- 不支持 RIGHT/FULL/CROSS JOIN、多 FROM 笛卡尔积、INSERT…SELECT、CTE、窗口函数、UNION、FOR UPDATE、EXPLAIN、流式读取、任意 sql 模板或原始 SQL。排序方向的内部 RawNode 是唯一特殊处理，不开放给作者写任意 RawNode。
- DDL 只支持建/删表、建/删索引、ALTER TABLE 加列/删列/改列名。建表最多 64 列、16 个约束；索引最多 16 列；主键、唯一约束和外键的列列表最多 8 项；单次 ALTER 最多 16 个列变更。没有 CHECK、触发器、视图、任意 DEFAULT 表达式或改列类型。
- 外键动作只有 cascade、set null、restrict、no action。不接受 set default。默认值只允许 null、布尔、有限数字，或匹配 `^[\p{L}\p{N} _.:-]{0,64}$`（u 标志）的字符串，不接受 NOW()等表达式。

executeQuery 仍可执行已编译的白名单查询（例如把 select 查询的 compile()结果传入），它也只提交操作节点树；不能借 CompiledQuery.raw 执行 SQL 字符串。

核心重建操作节点树、替换表名，再用自己的方言编译；插件发来的 SQL 字符串不执行。每条语句预算取本次调用剩余时间，不能用连续查询把事件、路由、迁移或拦截器的期限延长。SQLite 事务外 SELECT 在专用只读 worker 连接执行，超时中止；事务内查询跟随核心事务。SQLite 纯 VALUES INSERT 和 DDL 没有循环期限检查点，同步驱动不能保证硬中断，不要设计昂贵 DDL。

## 完整白名单

以下名字区分大小写。列表的固定标记用于测试，和网关实现逐字比对。逻辑 AND/OR、CASE 等由节点类型处理，不是下面的二元运算符名字。

### 二元运算符

<!-- whitelist:BINARY_OPERATORS -->

- `=`
- `!=`
- `<>`
- `>`
- `>=`
- `<`
- `<=`
- `in`
- `not in`
- `is`
- `is not`
- `like`
- `not like`
- `between`
- `+`
- `-`
- `*`
- `/`
- `%`

<!-- /whitelist:BINARY_OPERATORS -->

### 一元运算符

<!-- whitelist:UNARY_OPERATORS -->

- `not`
- `exists`
- `not exists`
- `-`

<!-- /whitelist:UNARY_OPERATORS -->

### 普通函数

<!-- whitelist:FUNCTIONS -->

- `lower`
- `upper`
- `abs`
- `round`
- `coalesce`
- `nullif`

<!-- /whitelist:FUNCTIONS -->

另有一个上下文限定的例外：`values` 函数只在 MySQL 风格的 onDuplicateKeyUpdate 中允许，不是可在普通 SELECT 调用的通用函数。

### 聚合

<!-- whitelist:AGGREGATES -->

- `count`
- `sum`
- `avg`
- `min`
- `max`

<!-- /whitelist:AGGREGATES -->

### JOIN、SELECT 修饰和外键动作

这里的 JOIN 名字是节点名，分别对应 innerJoin、leftJoin。

<!-- whitelist:JOIN_TYPES -->

- `InnerJoin`
- `LeftJoin`

<!-- /whitelist:JOIN_TYPES -->

<!-- whitelist:SELECT_MODIFIERS -->

- `Distinct`

<!-- /whitelist:SELECT_MODIFIERS -->

<!-- whitelist:FK_ACTIONS -->

- `cascade`
- `set null`
- `restrict`
- `no action`

<!-- /whitelist:FK_ACTIONS -->

### 数据类型

普通名字是 text、integer、bigint、smallint、boolean、real、double precision；带参数的只有 varchar(n)、char(n)、numeric(p, s)、decimal(p, s)。大小写、空格必须符合以下正则片段；片段依次用“或”组合并首尾锚定后，就是网关的数据类型白名单：

<!-- whitelist:DATA_TYPE -->

- `varchar\((\d{1,4})\)`
- `char\((\d{1,3})\)`
- `text`
- `integer`
- `bigint`
- `smallint`
- `boolean`
- `real`
- `double precision`
- `(?:numeric|decimal)\(\d{1,2}, \d{1,2}\)`

<!-- /whitelist:DATA_TYPE -->

varchar 的 n 是 1–4 位十进制数字，char 是 1–3 位；numeric/decimal 的 p、s 各 1–2 位，逗号后恰好一个空格。还须通过 Kysely 列类型识别；这些是语法范围，不代表 n=0、精度小于小数位等组合在数据库中合法。裸 varchar、date、timestamp、uuid、json、blob、serial 都不在白名单。

## 体积和结果上限

| 项目 | 上限 |
|---|---|
| 节点检查计数 | 5000 |
| 嵌套深度 | 64 |
| 普通列表 | 1000 项，更小的专用上限见上文 |
| 字符串参数 | UTF-8 编码 64 KiB |
| 二进制参数 | Uint8Array，256 KiB |
| 查询消息 | 序列化后 1 MiB |
| 结果 | 10000 行且序列化后 8 MiB |

参数接受 null、布尔、有限 number、有符号 64 位 bigint、字符串、Uint8Array；不接受 Date、NaN、Infinity、任意对象。DML 立即值只允许 null 和布尔，其余必须参数化。

顶层 SELECT 没有 LIMIT 或 LIMIT 大于 10000 时，核心下推 10001 的 LIMIT 作为超限探测，多出一行就拒绝；不是静默裁成 10000 行。写入可能已经提交后才发现返回消息超限，因此不要盲目重试非幂等写入。

网关错误 code 为 rejected（含拒绝原因）、timeout、constraint、failed；后三类不透出 SQL、参数或底层异常。约束错误需要你转成插件自己的用户提示，不要匹配各数据库的错误消息。

## 四种数据库的坑

插件必须兼容 SQLite、MySQL、MariaDB、PostgreSQL。网关白名单不等于自动方言翻译。

- 自增主键写法不同，autoIncrement()在 PostgreSQL 不可用；优先自然键或字符串键。不要从 Kysely 类型中看到 serial 就直接用，它不在白名单。
- MySQL 主键和索引列不能是 text，使用 varchar(n)。
- 时间统一存 UTC ISO 字符串，例如 `new Date().toISOString()`，列用 varchar。SQLite 没有原生日期类型，各驱动时区行为也不同。Date 参数会被拒绝；node:sqlite 还可能把第一位对象参数误认为命名参数表，使后续参数错位。
- count()结果可能是 number、string、bigint，统一 Number()；大整数需要考虑安全整数范围。受影响行数也是 bigint，不直接放进 JSON。
- MySQL 不支持 RETURNING，需要新行 id 时用 insertId 或自然键；不要期待 INSERT RETURNING 跨库可用。
- onConflict 是 SQLite/PostgreSQL 写法，onDuplicateKeyUpdate 是 MySQL/MariaDB 写法；SDK 没有公开方言选择入口。能用自然键加条件 UPDATE 表达的操作优先这样写。
- 计数和消费名额使用一条带条件的 UPDATE，不能“先读、再算、写回”。普通 handler 的多条语句没有整体原子性；只有[事务内拦截器](./interceptors.md)加入核心事务。
- MySQL 比较可能忽略末尾空格；字符串键先规范化，不要用首尾空白区分记录。SQLite 布尔可能读成 0/1，按你定义的存储约定转换，不假设驱动返回形状完全相同。

停用保留表；卸载后异步删除整个插件前缀下的表，不只当前 manifest 中的表，重新安装不会保留旧数据。迁移、条件更新和分页的完整例子见 [invitation-codes](https://github.com/Glasden/NextSkin/tree/main/plugins/invitation-codes)。
