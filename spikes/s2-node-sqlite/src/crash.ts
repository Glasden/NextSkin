/**
 * 崩溃测试：子进程在 WAL + synchronous=NORMAL 下连续提交事务，每次提交后把序号写到 stdout；
 * 父进程随机时刻 SIGKILL 它，然后重开数据库做 integrity_check，并确认"已报告提交"的事务全部在库里。
 * （进程崩溃不丢已提交事务；断电可能丢最后几个，这是 synchronous=NORMAL 的已知取舍，这里测不到。）
 *
 *   node src/crash.ts [轮数]
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from './schema.ts'

if (process.argv[2] === 'child') {
  const db = new DatabaseSync(process.argv[3]!)
  db.exec('pragma journal_mode = wal; pragma synchronous = normal')
  db.exec('create table if not exists t (seq integer primary key, payload blob not null)')
  db.exec('create table if not exists c (id integer primary key check (id = 1), n integer not null)')
  db.exec('insert or ignore into c values (1, 0)')
  const ins = db.prepare('insert into t values (?, randomblob(2000))')
  const inc = db.prepare('update c set n = n + 1')
  for (let seq = 1; ; seq++) {
    db.exec('begin immediate')
    ins.run(seq)
    inc.run()
    db.exec('commit')
    process.stdout.write(`${seq}\n`)
  }
} else {
  const rounds = Number(process.argv[2] ?? 20)
  let ok = 0
  for (let r = 0; r < rounds; r++) {
    const file = join(DATA_DIR, 'crash.db')
    for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true })
    const child = spawn(process.execPath, [import.meta.filename, 'child', file], { stdio: ['ignore', 'pipe', 'inherit'] })
    let lastReported = 0
    let buf = ''
    child.stdout.on('data', (b: Buffer) => {
      buf += b.toString()
      const lines = buf.split('\n')
      buf = lines.pop()!
      if (lines.length) lastReported = Number(lines.at(-1))
    })
    await new Promise((res) => setTimeout(res, 200 + Math.random() * 800))
    child.kill('SIGKILL')
    await new Promise((res) => child.on('exit', res))
    const db = new DatabaseSync(file)
    const integrity = (db.prepare('pragma integrity_check').get() as any).integrity_check
    const rows = (db.prepare('select count(*) n, max(seq) m from t').get() as any) as { n: number; m: number }
    const counter = (db.prepare('select n from c').get() as any).n
    db.close()
    const good = integrity === 'ok' && rows.m >= lastReported && rows.n === rows.m && counter === rows.n
    if (good) ok++
    else console.log(`第 ${r + 1} 轮异常：integrity=${integrity} 已报告=${lastReported} 行数=${rows.n} 最大序号=${rows.m} 计数器=${counter}`)
  }
  console.log(`崩溃测试 ${ok}/${rounds} 轮通过（integrity_check、已报告的提交都在、计数器与行数一致）`)
}
