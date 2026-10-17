import { tester } from '../rule-tester.ts'
import rule from './no-direct-score-write.ts'

const helpers = `import { insertOrIgnore, insertReturningId, upsert } from '@nextskin/db';`
const tables = ['users', 'users as u']
const objects = ['{ score: 1 }', "{ 'score': 1 }", '{ score }']
const factories = ['eb => ({ score: eb("score", "+", 1) })', 'eb => { return { score: 1 } }']
const rows = [...objects, ...factories, '[{ nickname: "a" }, { score: 1 }]', 'eb => [{ score: 1 }]']
const updates = [...objects, ...factories, "['nickname', 'score']"]

tester.run('no-direct-score-write', rule, {
  valid: [
    "db.selectFrom('users').select('score')",
    "db.selectFrom('users as u').select('u.score')",
    "db.updateTable('users').set({ nickname: 'a' })",
    "db.updateTable('users').set(eb => ({ nickname: 'a' }))",
    "db.insertInto('users').values({ nickname: 'a' })",
    "db.insertInto('users').values([{ nickname: 'a' }, { email: 'a@b.c' }])",
    "db.insertInto('users').values(eb => [{ nickname: 'a' }])",
    "db.updateTable('users as u').set({ 'other.score': 1 })",
    "db.updateTable('userstats').set({ score: 1 })",
    "db.updateTable('users_extra').set({ score: 1 })",
    ...[...objects, ...factories].map((value) => `db.updateTable('players').set(${value})`),
    ...rows.map((value) => `db.insertInto('players').values(${value})`),
    ...objects.map((value) => `${helpers} insertOrIgnore(db, 'players', ${value})`),
    ...rows.map((value) => `${helpers} upsert(db, 'players', { values: ${value}, update: ['nickname'] })`),
    ...updates.map((value) => `${helpers} upsert(db, 'players', { values, update: ${value} })`),
    ...['set', 'values'].flatMap((method) => {
      const start = method === 'set' ? 'updateTable' : 'insertInto'
      return [
        // 只检查同一接收者链，不追踪变量、包装函数或参数里的查询。
        `const query = db.${start}('users'); query.${method}({ score: 1 })`,
        `wrapper(db.${start}('users')).${method}({ score: 1 })`,
        `other.where(db.${start}('users')).${method}({ score: 1 })`,
        `db.${start}(table).${method}({ score: 1 })`,
        `db.${start}(\`users\`).${method}({ score: 1 })`,
        `db.${start}('users').${method}(values)`,
        `db.${start}('users').${method}(() => values)`,
        `db.${start}('users').${method}({ nested: { score: 1 } })`,
        // 计算属性和展开有意漏报，即使键或展开内容在本地看起来是静态的。
        `db.${start}('users').${method}({ ['score']: 1 })`,
        `db.${start}('users').${method}({ [column]: 1 })`,
        `db.${start}('users').${method}({ ...rest })`,
        `db.${start}('users').${method}({ ...{ score: 1 } })`,
        `db.${start}('users')['${method}']({ score: 1 })`,
        `db['${start}']('users').${method}({ score: 1 })`,
        `${start}('users').${method}({ score: 1 })`,
        `other.${method}({ score: 1 })`,
        `db.${start}('users').${method}`,
      ]
    }),
    "db.insertInto('users').values([{ ['score']: 1 }, { ...rest }])",
    "db.insertInto('users').values([...rows])",
    "db.updateTable('users').set('nickname', 'a')",
    "db.updateTable('users as u').set('other.score', 1)",
    "db.updateTable('players').set('score', 1)",
    `${helpers} insertReturningId(db, 'players', { score: 1 })`,
    `${helpers} insertReturningId(db, 'users', { nickname: 'a' })`,
    "db.updateTable('users').values({ score: 1 })",
    "db.insertInto('users').set({ score: 1 })",
    `${helpers} insertOrIgnore(db, 'users', { nickname: 'a' })`,
    `${helpers} insertOrIgnore(db, 'users', { ['score']: 1 })`,
    `${helpers} insertOrIgnore(db, 'users', { ...rest })`,
    `${helpers} insertOrIgnore(db, table, { score: 1 })`,
    `${helpers} insertOrIgnore(db, 'users', values)`,
    `${helpers} upsert(db, 'users', { values: { nickname: 'a' }, update: ['nickname'] })`,
    `${helpers} upsert(db, 'users', { values: { ['score']: 1 }, update: { ['score']: 2 } })`,
    `${helpers} upsert(db, 'users', { values: { ...rest }, update: ['nickname', ...columns] })`,
    `${helpers} upsert(db, 'users', { ['values']: { score: 1 }, ['update']: ['score'] })`,
    `${helpers} upsert(db, 'users', { ...options })`,
    `${helpers} upsert(db, 'users', { values, update: eb => ({ nickname: 'a' }) })`,
    `${helpers} upsert(db, 'users', { values, update: ['score_extra'] })`,
    `${helpers} upsert(db, 'users', { values, update: [column] })`,
    `${helpers} upsert(db, 'users', { values, conflict: ['score'] })`,
    `${helpers} upsert(db, table, { values: { score: 1 } })`,
    `${helpers} upsert(db, 'users', options)`,
    `${helpers} insertOrIgnore(); upsert()`,
    // 同名函数必须确实来自 @nextskin/db，局部遮蔽也不算。
    "insertOrIgnore(db, 'users', { score: 1 })",
    "upsert(db, 'users', { values: { score: 1 } })",
    "import { insertOrIgnore, upsert } from 'other'; insertOrIgnore(db, 'users', { score: 1 }); upsert(db, 'users', { update: ['score'] })",
    `${helpers} function other(insertOrIgnore, upsert) { insertOrIgnore(db, 'users', { score: 1 }); upsert(db, 'users', { update: ['score'] }) }`,
    `${helpers} { const insertOrIgnore = other; insertOrIgnore(db, 'users', { score: 1 }) }`,
    "import * as database from '@nextskin/db'; function other(database) { database.upsert(db, 'users', { update: ['score'] }) }",
    "import * as database from 'other'; database.upsert(db, 'users', { update: ['score'] })",
    "import * as database from '@nextskin/db'; database['insertOrIgnore'](db, 'users', { score: 1 })",
    "import database from '@nextskin/db'; database.upsert(db, 'users', { update: ['score'] })",
    "import { countRows } from '@nextskin/db'; countRows(db, 'users', { score: 1 })",
    "// db.updateTable('users').set({ score: 1 })\nconst text = 'score'",
  ],
  invalid: [
    ...tables
      .flatMap((table) => [
        ...[...objects, ...factories].map((value) => `db.updateTable('${table}').set(${value})`),
        ...rows.map((value) => `db.insertInto('${table}').values(${value})`),
        ...objects.map((value) => `${helpers} insertOrIgnore(db, '${table}', ${value})`),
        ...rows.map((value) => `${helpers} upsert(db, '${table}', { values: ${value}, update: ['nickname'] })`),
        ...updates.map((value) => `${helpers} upsert(db, '${table}', { values, update: ${value} })`),
        ...['set', 'values'].flatMap((method) => {
          const start = method === 'set' ? 'updateTable' : 'insertInto'
          return [
            `db.${start}('${table}').where('id', '=', 1).${method}({ score: 1 })`,
            `db?.${start}?.('${table}')?.where?.('id', '=', 1)?.${method}?.({ score: 1 })`,
            `(db?.${start}('${table}')).${method}({ score: 1 })`,
            `(db.${start}('${table}').${method})({ score: 1 })`,
            `db.${start}('${table}').${method}({ ...rest, score: 1 })`,
          ]
        }),
      ])
      .map((code) => ({ code, errors: [{ messageId: 'forbidden' }] })),
    ...[
      "db.updateTable('users as u').set({ 'u.score': 1 })",
      "db.updateTable('users as account').set(eb => ({ 'account.score': eb('account.score', '+', 1) }))",
      "db.updateTable('users').set({ 'users.score': 1 })",
      "db.insertInto('users as u').values([{ 'u.score': 1 }])",
      "db.insertInto('users').values(eb => { return [{ nickname: 'a' }, { 'score': 1 }] })",
      `${helpers} upsert(db, 'users', { values: { score: 1 }, update: ['score'] })`,
      `${helpers} upsert(db, 'users as u', { values, update: ['u.score'] })`,
      `${helpers} insertOrIgnore?.(db, 'users', { score: 1 })`,
      `${helpers} upsert?.(db, 'users', { values, update: ['score'] })`,
      "import { insertOrIgnore as insert, upsert as save } from '@nextskin/db'; insert(db, 'users', { score: 1 })",
      "import { upsert as save } from '@nextskin/db'; save(db, 'users', { update: ['score'] })",
      "import { 'insertOrIgnore' as insert } from '@nextskin/db'; insert(db, 'users', { score: 1 })",
      "import * as database from '@nextskin/db'; database.insertOrIgnore(db, 'users', { score: 1 })",
      "import * as database from '@nextskin/db'; database?.upsert?.(db, 'users', { update: ['score'] })",
      "import * as database from '@nextskin/db'; (database?.upsert)(db, 'users', { update: { score: 1 } })",
      `${helpers} function create() { return insertOrIgnore(db, 'users', { score: 1 }) }`,
      // Kysely 的 set(列名, 值) 重载
      "db.updateTable('users').set('score', 1)",
      "db.updateTable('users as u').where('id', '=', 1).set('u.score', 1)",
      "db.updateTable('users').set('users.score', eb => eb('score', '+', 1))",
      `${helpers} insertReturningId(db, 'users', { nickname: 'a', score: 1 })`,
      `${helpers} insertReturningId(tx, 'users as u', { 'u.score': 1 })`,
    ].map((code) => ({ code, errors: [{ messageId: 'forbidden' }] })),
  ],
})
