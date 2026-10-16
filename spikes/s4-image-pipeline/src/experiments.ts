import { readFile,readdir,writeFile,stat } from 'node:fs/promises';
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { decode,encodePng,encodeFast,encodePngjs,sha,pixelHash,validate,probe,upload,type Image } from './png.ts';
import { inferModel,avatar2d,preview2d,extract } from './render.ts';
import { referenceAvatar,referenceFront,referencePreview } from './reference.ts';
import { renders } from './golden.ts';
import { initWebp,encodeWebp } from './webp.ts';
import { samplePng } from './corpus.ts';
const models=[],hashes=[],sizes=[],cross=[];
for(const name of await readdir('fixtures/real')){
  const b=await readFile(`fixtures/real/${name}`),i=decode(b),a=decode(b,'fast-png');
  const kind=name.includes('cape')?'cape':name==='ears.png'?'ears':'skin';
  models.push({name,width:i.width,height:i.height,kind,model:kind==='skin'?inferModel(i):'不适用',decoderBEqual:pixelHash(i)===pixelHash(a),depth:probe(b).depth,...(kind!=='ears'?{normalizedA:upload(b,kind as 'skin'|'cape').hashA}:{})});
  if(kind==='skin'){
    const model=inferModel(i);for(const n of [64,128,512]){const ts=avatar2d(i,n),ref=await referenceAvatar(i,n);cross.push(compare(`${name}:avatar-${n}`,ts,ref));}
    for(const n of [256,512]){cross.push(compare(`${name}:full-preview-${n}`,preview2d(i,model,n),await referencePreview(i,model,n)));cross.push(compare(`${name}:front-${n}`,extract(preview2d(i,model,n),0,0,n/2,n),await referenceFront(i,model,n)));}
  }
}
function compare(name:string,a:Image,b:Image){let channels=0,maxDelta=0;for(let p=0;p<a.data.length;p++)if(a.data[p]!==b.data[p]){channels++;maxDelta=Math.max(maxDelta,Math.abs(a.data[p]-b.data[p]));}return {name,channels,maxDelta};}
// 同一像素，编码器和压缩等级交叉；含隐藏 RGB。
const i=samplePng(6,16).expected;i.data.set([12,34,56,0],0);
for(const level of [0,1,6,9] as const)for(const [encoder,fn]of [['node:zlib',encodePng],['fast-png(fflate)',encodeFast],['pngjs(zlib)',encodePngjs]] as const){const b=fn(i,level);hashes.push({encoder,level,bytes:b.length,A:sha(b),canonicalA:upload(b).hashA,B:pixelHash(decode(b)),originalB:pixelHash(i)});}
const child=spawnSync(process.execPath,['--import','tsx','src/wasm-init.ts'],{encoding:'utf8',timeout:10000});if(child.status!==0)throw Error(child.stderr);const init=JSON.parse(child.stdout.trim());await initWebp();
for(const [name,image]of Object.entries(await renders())){
  const p=encodePng(image),f=encodeFast(image),j=encodePngjs(image),w=await encodeWebp(image);
  const decoded=await sharp(w).ensureAlpha().raw().toBuffer();
  sizes.push({name,png:p.length,fast:f.length,pngjs:j.length,webp:w.length,exact:Buffer.from(image.data).equals(decoded)});
}
const wasmPaths=['webp_enc.wasm','webp_enc_simd.wasm'];const wasmBytes={};for(const name of wasmPaths)Object.assign(wasmBytes,{[name]:(await stat(`node_modules/@jsquash/webp/codec/enc/${name}`)).size});
const result={node:process.version,models,hashes,cross,sizes,wasm:{...init,bytes:wasmBytes}};await writeFile(`out/experiments-node${process.versions.node.split('.')[0]}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({models,cross:cross.filter(r=>r.channels),wasm:result.wasm},null,2));
