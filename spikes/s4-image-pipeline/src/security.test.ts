import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { upload,chunks,pixelHash } from './png.ts';
test('45 个健壮性语料 × 4 路径，独立进程 5 秒限时；安全候选无错误接受/像素变化',async()=>{
  await promisify(execFile)(process.execPath,['--import','tsx','src/robustness.ts'],{timeout:180000,maxBuffer:1024*1024});
  const {rows}=JSON.parse(await readFile('out/robustness.json','utf8'));
  assert.equal(rows.length,180);
  for(const r of rows.filter((r:{mode:string})=>r.mode==='safe-pngjs')){assert.equal(r.accepted,r.valid,r.name);if(r.valid)assert(r.pixelsCorrect,r.name);assert.equal(r.signal,null,r.name);}
  for(const name of ['metadata-and-tail','iCCP-200MiB','trailing-data','APNG-default']){
    const b=await readFile(`out/corpus/${name}.png`),o=upload(b);assert.deepEqual(chunks(o.png).map(c=>c.type),['IHDR','IDAT','IEND']);assert.equal(o.hashB,pixelHash(o.image));
    assert.equal(o.png.length,chunks(o.png).reduce((n,c)=>n+c.bytes.length,8));
  }
});
