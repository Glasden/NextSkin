import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { expect } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { signEntry, type ReleaseEntry } from '@nextskin/updates'
import { initialCurrent, writeCurrent } from './state.ts'
import type { Dialect } from './types.ts'

export interface Behavior {
  dialect?: Dialect
  pending?: boolean
  pluginPending?: boolean
  fail?: string
  unknown?: boolean
  incomplete?: boolean
  health?: number
  exit?: number
  exitAfter?: number
  ignoreShutdown?: boolean
  migrateFail?: boolean
  migrateKind?: string
  migrateMessage?: string
  noBackup?: boolean
  doctorDelay?: number
  incompatible?: boolean
}
// 假版本也走真实 IPC、HTTP 和数据锁，避免只验证管理进程自己的分支。
export const launcher = `
import { readFileSync, appendFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
const home = process.env.NEXTSKIN_HOME
const version = readFileSync(new URL('./server/VERSION', import.meta.url), 'utf8').trim()
const config = JSON.parse(readFileSync(join(home, 'fixture.json'), 'utf8'))
const cfg = config[version] || {}
const dataDirectory = join(home, 'data')
const sqliteFile = join(dataDirectory, 'db.sqlite')
mkdirSync(dataDirectory, { recursive: true })
const command = process.argv[2]
appendFileSync(join(home, 'events.jsonl'), JSON.stringify({command,version,managed:process.env.NEXTSKIN_MANAGED,manager:process.env.NEXTSKIN_MANAGER})+'\\n')
const dialect = cfg.dialect || 'sqlite'
const content = existsSync(sqliteFile) ? readFileSync(sqliteFile, 'utf8') : ''
const pendingCore = !!cfg.pending && content !== 'db:'+version
const pendingPlugin = !!cfg.pluginPending && content !== 'db:'+version
const pending = pendingCore || pendingPlugin
if (command === 'doctor') {
  if (cfg.doctorDelay) await new Promise(r => setTimeout(r,cfg.doctorDelay))
  const results = ['node','envFile','secret','config','dataDirectory','database','release','pluginHost','service'].map(id=>({id,item:id,status:id==='service' ? 'fail' : id===cfg.fail ? 'fail' : 'pass',message:id===cfg.fail ? '测试预检失败' : '测试检查'}))
  const database = { dialect, pendingCore: pendingCore?['core-1']:[],pendingPlugins:pendingPlugin?[{plugin:'official',migrations:['plugin-1']}]:[],unknownCore:cfg.unknown?['future']:[],incompatiblePlugins:cfg.incompatible?[{id:'test',api:'99.0'}]:[],sqliteFile:dialect==='sqlite'?sqliteFile:null }
  console.log(JSON.stringify(cfg.incomplete?{results}:{version,dataDirectory,results,database}))
  process.exitCode=1
} else if (command === 'migrate') {
  let backup=null
  if (pending && dialect==='sqlite' && !cfg.noBackup) {
    backup=join(dataDirectory,'backup-'+version+'.sqlite')
    copyFileSync(sqliteFile,backup)
  }
  if (cfg.migrateFail) {
    if (dialect==='mysql' || dialect==='mariadb') writeFileSync(sqliteFile,'partial')
    console.log(JSON.stringify({error:{kind:cfg.migrateKind||'migration',message:cfg.migrateMessage||'测试迁移失败'}}))
    process.exitCode=1
  } else {
    if(pending) writeFileSync(sqliteFile,'db:'+version)
    console.log(JSON.stringify({core:pendingCore?['core-1']:[],plugins:pendingPlugin?[{plugin:'official',migrations:['plugin-1']}]:[],backup}))
  }
} else if(command==='start') {
  if(cfg.exit!==undefined) process.exit(cfg.exit)
  const lock = new DatabaseSync(join(dataDirectory,'nextskin.lock'),{timeout:0})
  try { lock.exec('BEGIN EXCLUSIVE') } catch { process.exit(78) }
  const server=createServer((req,res)=>{res.statusCode=cfg.health||200;res.end('health')})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  process.send?.({nextskin:'ready',version,host:'127.0.0.1',port:server.address().port})
  const shutdown=()=>{
    appendFileSync(join(home,'events.jsonl'),JSON.stringify({command:'shutdown',version})+'\\n')
    if(!cfg.ignoreShutdown) { server.closeAllConnections();server.close(()=>{lock.close();process.exit(0)}) }
  }
  process.on('message',m=>{if(m?.nextskin==='shutdown')shutdown()})
  process.on('disconnect',shutdown)
  process.on('SIGTERM',()=>appendFileSync(join(home,'events.jsonl'),JSON.stringify({command:'signal',version})+'\\n'))
  if(cfg.exitAfter!==undefined)setTimeout(()=>process.exit(1),cfg.exitAfter)
} else {
  console.log('fake '+command+' '+version)
}
`

export async function fixture(versions = ['1.0.0', '1.1.0']) {
  const home = await mkdtemp(join(tmpdir(), 'nextskin-manager-'))
  const behavior: Record<string, Behavior> = {}
  for (const version of versions) {
    behavior[version] = {}
    const root = join(home, 'releases', version)
    await mkdir(join(root, 'cli'), { recursive: true })
    await mkdir(join(root, 'server'), { recursive: true })
    await writeFile(join(root, 'nextskin.mjs'), launcher)
    await writeFile(join(root, 'cli/main.mjs'), '')
    await writeFile(join(root, 'server/VERSION'), version)
  }
  await mkdir(join(home, 'data'), { recursive: true })
  await mkdir(join(home, 'manager'), { recursive: true })
  await writeFile(join(home, 'manager/VERSION'), versions[0]!)
  await writeFile(join(home, 'data/db.sqlite'), 'original')
  const configure = () => writeFile(join(home, 'fixture.json'), JSON.stringify(behavior))
  await configure()
  await writeCurrent(home, initialCurrent(versions[0]!))
  return { home, behavior, configure, dispose: () => rm(home, { recursive: true, force: true }) }
}
export async function events(
  home: string,
): Promise<{ command: string; version: string; managed?: string; manager?: string }[]> {
  try {
    return (await readFile(join(home, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { command: string; version: string })
  } catch {
    return []
  }
}
export function releaseZip(version: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    [`nextskin/releases/${version}/nextskin.mjs`]: strToU8(launcher),
    [`nextskin/releases/${version}/cli/main.mjs`]: strToU8(''),
    [`nextskin/releases/${version}/server/VERSION`]: strToU8(version),
    'nextskin/manager/main.mjs': strToU8('// manager'),
    'nextskin/manager/VERSION': strToU8(version),
    ...extra,
  })
}
export function signedManifest(zip: Uint8Array, version = '1.1.0', overrides: Partial<ReleaseEntry> = {}) {
  const pair = generateKeyPairSync('ed25519')
  const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const keys = { test: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() }
  const entry: ReleaseEntry = {
    version,
    date: '2026-10-23T00:00:00Z',
    notes: 'https://example.test/release',
    file: `nextskin-${version}.zip`,
    sha256: createHash('sha256').update(zip).digest('hex'),
    size: zip.length,
    minNode: 24,
    managerProtocol: 1,
    ...overrides,
  }
  return { keys, entry, body: { schema: 1, releases: [signEntry(entry, privateKey, 'test')] } }
}
export function zipResponse(zip: Uint8Array): Response {
  return new Response(Buffer.from(zip))
}

export function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}
export function contains(value: string): unknown {
  return expect.stringContaining(value) as unknown
}
