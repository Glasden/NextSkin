/**
 * 基准用的简化 schema 与种子数据，规模按"中型站点"估计。
 * 种子数据用 node:sqlite 直接写入（一个事务），生成后做一次 checkpoint，之后每轮基准复制一份使用。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const DATA_DIR = join(import.meta.dirname, '..', 'data')

export const SIZES = {
  users: 50_000,
  players: 60_000,
  textures: 100_000,
  closetPerUser: 10,
  sessions: 50_000,
  pluginRecords: 200_000,
}

export interface DB {
  users: { uid: number; email: string; nickname: string; score: number; password: string; created_at: string }
  players: { pid: number; uid: number; name: string; uuid: string; tid_skin: number | null; tid_cape: number | null; last_modified: string }
  textures: { tid: number; name: string; type: string; hash: string; size: number; uploader: number; public: number; likes: number; upload_at: string }
  closet: { uid: number; tid: number; item_name: string }
  likes: { uid: number; tid: number }
  ygg_sessions: { server_id: string; pid: number; access_token: string; ip: string | null; created_at: string }
  p_demo__records: { id: number; k: number; v: number; note: string }
}

const DDL = `
create table users (uid integer primary key, email text not null unique, nickname text not null, score integer not null default 0, password text not null, created_at text not null);
create table textures (tid integer primary key, name text not null, type text not null, hash text not null, size integer not null, uploader integer not null references users(uid), public integer not null, likes integer not null default 0, upload_at text not null);
create index textures_uploader on textures(uploader);
create index textures_public_likes on textures(public, likes);
create table players (pid integer primary key, uid integer not null references users(uid), name text not null collate nocase unique, uuid text not null unique, tid_skin integer references textures(tid), tid_cape integer references textures(tid), last_modified text not null);
create index players_uid on players(uid);
create table closet (uid integer not null references users(uid), tid integer not null references textures(tid), item_name text not null, primary key (uid, tid)) without rowid;
create table likes (uid integer not null, tid integer not null, primary key (uid, tid)) without rowid;
create table ygg_sessions (server_id text primary key, pid integer not null references players(pid), access_token text not null, ip text, created_at text not null);
create table p_demo__records (id integer primary key, k integer not null, v integer not null, note text not null);
`

/** 确定性的伪随机数，保证每次生成的种子数据一致 */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export function seedPath() {
  return join(DATA_DIR, 'seed.db')
}

export function ensureSeed(): string {
  const file = seedPath()
  if (existsSync(file)) return file
  mkdirSync(DATA_DIR, { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = wal')
  db.exec(DDL)
  const r = rng(42)
  const now = new Date('2026-01-01T00:00:00Z').toISOString()
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('')
  db.exec('begin')
  const u = db.prepare('insert into users values (?, ?, ?, ?, ?, ?)')
  for (let i = 1; i <= SIZES.users; i++) u.run(i, `u${i}@example.com`, `user${i}`, 1000, `$2y$10$${hex(53)}`, now)
  const t = db.prepare('insert into textures values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (let i = 1; i <= SIZES.textures; i++) {
    t.run(i, `texture ${i}`, r() < 0.8 ? 'steve' : r() < 0.5 ? 'alex' : 'cape', hex(64), 1 + Math.floor(r() * 30), 1 + Math.floor(r() * SIZES.users), r() < 0.7 ? 1 : 0, Math.floor(r() * 100), now)
  }
  const p = db.prepare('insert into players values (?, ?, ?, ?, ?, ?, ?)')
  for (let i = 1; i <= SIZES.players; i++) {
    p.run(i, 1 + Math.floor(r() * SIZES.users), `p${i}`, hex(32), 1 + Math.floor(r() * SIZES.textures), r() < 0.3 ? 1 + Math.floor(r() * SIZES.textures) : null, now)
  }
  const c = db.prepare('insert or ignore into closet values (?, ?, ?)')
  for (let uid = 1; uid <= SIZES.users; uid++) {
    for (let j = 0; j < SIZES.closetPerUser; j++) c.run(uid, 1 + Math.floor(r() * SIZES.textures), `item ${j}`)
  }
  const s = db.prepare('insert into ygg_sessions values (?, ?, ?, ?, ?)')
  for (let i = 1; i <= SIZES.sessions; i++) s.run(`s${i}`, i, hex(32), '127.0.0.1', now)
  const pr = db.prepare('insert into p_demo__records values (?, ?, ?, ?)')
  for (let i = 1; i <= SIZES.pluginRecords; i++) pr.run(i, Math.floor(r() * 1000), Math.floor(r() * 1_000_000), `note ${i}`)
  db.exec('commit')
  db.exec('analyze')
  db.exec('pragma wal_checkpoint(truncate)')
  db.close()
  return file
}

/** 每轮基准用一份全新的副本 */
export function freshCopy(name: string): string {
  const src = ensureSeed()
  const dst = join(DATA_DIR, `${name}.db`)
  for (const suffix of ['', '-wal', '-shm']) rmSync(dst + suffix, { force: true })
  copyFileSync(src, dst)
  return dst
}
