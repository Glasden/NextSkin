import { readFile,readdir,writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { Bench } from 'tinybench';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { decode,guard,probe,upload,encodePng,encodeFast,encodePngjs,sha,pixelHash,validate,type Image } from './png.ts';
import { avatar2d,avatar3d,body3d,preview2d,inferModel } from './render.ts';
import { encodeWebp,initWebp } from './webp.ts';
import { referenceAvatar,referencePreview } from './reference.ts';
let sink:unknown;const rows:unknown[]=[];
async function measure(group:string,name:string,implementation:string,fn:()=>unknown|Promise<unknown>){
  const bench=new Bench({time:150,iterations:100,warmupTime:30,warmupIterations:8,retainSamples:false});
  bench.add(name,async()=>{sink=await fn();});await bench.run();const r=bench.tasks[0].result;
  if(r.state!=='completed')throw Error(`${name}: ${JSON.stringify(r)}`);
  const row={group,name,implementation,median:r.latency.p50,p99:r.latency.p99,samples:bench.tasks[0].runs};rows.push(row);console.log(JSON.stringify(row));
}
// 一次只运行一个版本，一个任务；不启动并发 benchmark。
const init=await initWebp();
const names=['real/deadmau5.png','real/hatsune_miku.png','real/ironman_hd.png','real/hd_cape.png',...(await readdir('fixtures/synthetic')).sort().map(n=>`synthetic/${n}`)];
for(const name of names){
  const b=await readFile(`fixtures/${name}`);
  for(const lib of ['pngjs','fast-png'] as const)await measure('decode',name,`safe-${lib}`,()=>decode(b,lib));
  await measure('decode',name,'raw-pngjs',()=>PNG.sync.read(b));
  await measure('decode',name,'sharp',()=>sharp(b).ensureAlpha().raw().toBuffer());
  await measure('guard',name,'guard',()=>guard(b));
  await measure('upload',name,'TS',()=>upload(b,name.includes('cape')?'cape':'skin'));
  await measure('upload',name,'sharp',async()=>{guard(b);const r=await sharp(b).ensureAlpha().raw().toBuffer({resolveWithObject:true});const i=validate({width:r.info.width,height:r.info.height,data:r.data},name.includes('cape')?'cape':'skin');const p=await sharp(i.data,{raw:{width:i.width,height:i.height,channels:4}}).png({compressionLevel:6,adaptiveFiltering:true}).toBuffer();return {hashA:sha(p),hashB:pixelHash(i)};});
}
const skin=decode(await readFile('fixtures/real/hatsune_miku.png')),model=inferModel(skin);
const renderers:[string,number[],(size:number)=>Image][]=[['avatar2d',[64,128,512],n=>avatar2d(skin,n)],['avatar3d',[128,512],n=>avatar3d(skin,n)],['body3d',[256,512],n=>body3d(skin,model,n)],['preview2d',[256,512],n=>preview2d(skin,model,n)]];
for(const [name,sizes,render]of renderers)for(const size of sizes){
  const image=render(size);const key=`${name}-${size}`;
  await measure('render',key,'TS+PNG',()=>encodePng(render(size)));
  await measure('render',key,'TS+WebP',async()=>encodeWebp(render(size)));
  // sharp 不含 3D 光栅器；3D 使用同一个 TS raster，只比较编码，不能当作原生 3D 加速结论。
  await measure('render',key,name==='avatar3d'||name==='body3d'?'TS+sharpPNG':'sharpPNG',async()=>{
    const i=name==='avatar2d'?await referenceAvatar(skin,size):name==='preview2d'?await referencePreview(skin,model,size):render(size);
    return sharp(i.data,{raw:{width:i.width,height:i.height,channels:4}}).png({compressionLevel:6,adaptiveFiltering:true}).toBuffer();
  });
  for(const [encoder,fn]of [['node:zlib',encodePng],['fast-png',encodeFast],['pngjs',encodePngjs]] as const)await measure('encode',key,encoder,()=>fn(image));
  await measure('encode',key,'WebP-WASM',()=>encodeWebp(image));
  await measure('encode',key,'sharpPNG',()=>sharp(image.data,{raw:{width:image.width,height:image.height,channels:4}}).png({compressionLevel:6,adaptiveFiltering:true}).toBuffer());
}
const output={node:process.version,platform:process.platform,arch:process.arch,cpus:cpus().length,cpu:cpus()[0].model,options:{timeMs:150,minSamples:100,warmupMs:30,warmupIterations:8},wasm:init,rows};
await writeFile(`out/bench-node${process.versions.node.split('.')[0]}.json`,JSON.stringify(output,null,2));void sink;
