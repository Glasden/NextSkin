import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { parseDotenv, readBsEnvironment } from './env.ts'

test('按 phpdotenv 的写法解析 .env', () => {
  const env = parseDotenv(
    [
      '﻿# 注释',
      'DB_CONNECTION=mysql',
      'DB_HOST = db.local  # 行尾注释',
      'export DB_DATABASE=blessingskin',
      'DB_PASSWORD=\'p#ss "word" ${DB_HOST}\'',
      'SALT="a\\"b\\\\c\\n${DB_DATABASE}\\${DB_HOST}"',
      'DB_PREFIX=',
      'MULTI="line1',
      'line2"',
      'BROKEN LINE',
      'TEXTURES_DIR=${DB_DATABASE}/textures',
    ].join('\r\n'),
  )
  expect(env).toEqual({
    DB_CONNECTION: 'mysql',
    DB_HOST: 'db.local',
    DB_DATABASE: 'blessingskin',
    DB_PASSWORD: 'p#ss "word" ${DB_HOST}',
    SALT: 'a"b\\c\nblessingskin${DB_HOST}',
    DB_PREFIX: '',
    MULTI: 'line1\nline2',
    TEXTURES_DIR: 'blessingskin/textures',
  })
})

test('从 .env 取连接、前缀、密码算法、盐和材质目录，相对路径按 .env 所在目录', () => {
  const root = resolve('/srv/bs')
  expect(
    readBsEnvironment(
      parseDotenv(
        'DB_CONNECTION=pgsql\nDB_HOST=pg\nDB_DATABASE=bs\nDB_USERNAME=u\nDB_PASSWORD=p\nDB_PREFIX=bs_\nPWD_METHOD=SALTED2MD5\nSALT=x\nTEXTURES_DIR=data/t',
      ),
      root,
    ),
  ).toEqual({
    connection: { dialect: 'postgres', host: 'pg', port: 5432, database: 'bs', username: 'u', password: 'p' },
    prefix: 'bs_',
    passwordMethod: 'SALTED2MD5',
    salt: 'x',
    texturesDirectory: join(root, 'data', 't'),
    localTextures: true,
  })
  // 默认值：mysql、BS 的 storage/textures；SQLite 的库文件相对 .env 所在目录
  expect(readBsEnvironment(parseDotenv('DB_DATABASE=bs\nFS_DRIVER=s3'), root)).toMatchObject({
    connection: { dialect: 'mysql', host: '127.0.0.1', port: 3306 },
    passwordMethod: null,
    texturesDirectory: join(root, 'storage', 'textures'),
    localTextures: false,
  })
  expect(
    readBsEnvironment(parseDotenv('DB_CONNECTION=sqlite\nDB_DATABASE=database/bs.sqlite'), root).connection,
  ).toEqual({
    dialect: 'sqlite',
    file: join(root, 'database', 'bs.sqlite'),
  })
  expect(readBsEnvironment(parseDotenv('DB_CONNECTION=sqlsrv\nDB_DATABASE=bs'), root).connection).toBeNull()
})
