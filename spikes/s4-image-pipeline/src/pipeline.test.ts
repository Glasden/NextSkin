import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { decode,encodePng,encodeFast,encodePngjs,upload,pixelHash,sha,validate,chunks,chunk,signature,probe,type Image } from './png.ts';
import { formats,samplePng } from './corpus.ts';
import { avatar2d,avatar3d,body3d,preview2d,inferModel,prepareSkin,blank,extract,rasterize,boxes,capePreview } from './render.ts';
import { referenceAvatar,referenceFront,referencePreview } from './reference.ts';
import { renders } from './golden.ts';
import { encodeWebp } from './webp.ts';
import sharp from 'sharp';

test('全部 30 个格式组合：RGBA、tRNS 隐藏 RGB、16 位高字节、Adam7',()=>{for(const s of formats())assert.deepEqual(decode(s.bytes),s.expected,s.name);});
test('fast-png 的已知缺陷可复现；其余格式与参考像素一致',()=>{
  for(const s of formats())if(/ct[03]-d[124]-adam7/.test(s.name))assert.throws(()=>decode(s.bytes,'fast-png'),s.name);else assert.deepEqual(decode(s.bytes,'fast-png'),s.expected,s.name);
});
test('三个编码器往返、RGBA 隐藏 RGB 与确定性',()=>{
  const image=samplePng(6,16).expected;image.data.set([12,34,56,0],0);
  for(const encoder of [encodePng,encodeFast,encodePngjs]){const b=encoder(image);assert.deepEqual(decode(b),image);assert.equal(upload(b).hashA,sha(encodePng(image)));assert.deepEqual(encoder(image),b);assert.deepEqual(chunks(b).map(c=>c.type),['IHDR','IDAT','IEND']);}
  assert.deepEqual(upload(encodePng(image)).image,image);
});
test('尺寸校验、披风补边、上限与块数上限',()=>{
  const b=samplePng(6,8).bytes;const many=Buffer.concat([b.subarray(0,33),...Array.from({length:4096},()=>chunk('tEXt',Buffer.from('a\0b'))),b.subarray(33)]);assert.throws(()=>decode(many),/块数/);
  for(const [w,h]of [[64,32],[64,64],[1024,512],[1024,1024]])assert.equal(validate(blank(w,h),'skin').width,w);
  for(const [w,h]of [[63,64],[64,48],[1088,1088]])assert.throws(()=>validate(blank(w,h),'skin'));
  for(const k of [1,2,4]){const i=blank(22*k,17*k);i.data.fill(123);const o=validate(i,'cape');assert.equal(o.width,64*k);assert.deepEqual(extract(o,0,0,i.width,i.height),i);assert.equal(o.data.at(-1),0);}
  for(const [w,h]of [[64,64],[22,34],[46,22]])assert.throws(()=>validate(blank(w,h),'cape'));
  const configured=upload(encodePng(blank(1088,544)),'skin',1088).image;assert.equal(prepareSkin(configured).width,1088);
  const wideCape=upload(encodePng(blank(22*17,17*17)),'cape',1088).image;assert.equal(capePreview(wideCape,64).height,64);
  const huge=encodePng(blank(1088,32));assert.throws(()=>decode(huge),/上限/);assert.equal(probe(huge).width,1088);
});
test('旧格式镜像、alpha<128 帽子修复、基础层保留隐藏 RGB',()=>{
  const old=blank(128,64);old.data.fill(255);const p=(20*2*128+4*2)*4;old.data.set([12,34,56,0],p);
  const o=prepareSkin(old);assert.deepEqual([...o.data.slice(p,p+4)],[12,34,56,255]);assert.equal(o.data[(8*2*128+40*2)*4+3],0);
  const source=(20*2*128+4*2)*4,dest=(52*2*128+20*2+7)*4;assert.deepEqual(o.data.slice(dest,dest+4),o.data.slice(source,source+4));
  old.data[(8*2*128+40*2)*4+3]=127;assert.equal(prepareSkin(old).data[(8*2*128+41*2)*4+3],255);
  old.data[(8*2*128+40*2)*4+3]=128;assert.equal(prepareSkin(old).data[(8*2*128+41*2)*4+3],0);
  assert.equal(inferModel(old),'default');assert.deepEqual(old.data.slice(p,p+4),new Uint8Array([12,34,56,0]));
});
test('真实皮肤 avatar2d、preview2d 正面与 sharp 完全一致',async()=>{
  for(const name of await readdir('fixtures/real')){
    if(name.includes('cape')||name==='ears.png')continue;
    const i=decode(await readFile(`fixtures/real/${name}`));try{validate(i,'skin');}catch{continue;}
    const model=inferModel(i);
    for(const size of [64,128,512])assert.deepEqual(avatar2d(i,size).data,new Uint8Array((await referenceAvatar(i,size)).data),`${name} avatar ${size}`);
    for(const height of [256,512]){
      const preview=preview2d(i,model,height);assert.deepEqual(preview.data,new Uint8Array((await referencePreview(i,model,height)).data),`${name} full preview`);const front=extract(preview,0,0,height/2,height);assert.deepEqual(front.data,new Uint8Array((await referenceFront(i,model,height)).data),`${name} front ${height}`);
    }
  }
});
test('相机、明暗与 UV 朝向：三面角点和 alpha 深度',()=>{
  const s=blank(64,64);const paint=(x:number,y:number,w:number,h:number,c:number[])=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)s.data.set(c,(yy*64+xx)*4);};
  paint(8,0,8,8,[255,0,0,255]);paint(8,8,8,8,[0,255,0,255]);paint(16,8,8,8,[0,0,255,255]);
  // 顶面前后和侧面前后均有非对称标记，防止整体镜像。
  paint(8,0,1,1,[255,255,0,255]);paint(23,8,1,1,[255,0,255,255]);
  const img=rasterize(s,[boxes('default',true)[0]],128,128);
  const colors=new Set<string>();for(let p=0;p<img.data.length;p+=4)if(img.data[p+3])colors.add([...img.data.slice(p,p+4)].join(','));
  for(const c of ['255,0,0,255','0,217,0,255','0,0,179,255','255,255,0,255','179,0,179,255'])assert(colors.has(c),c);
  let frontX=0,sideX=0,nf=0,ns=0;for(let p=0;p<img.data.length;p+=4){if(img.data[p+1]===217){frontX+=(p/4)%128;nf++;}if(img.data[p+2]===179){sideX+=(p/4)%128;ns++;}}assert(frontX/nf<sideX/ns);
  // 被不透明前面遮挡的远处透明面不会泄漏；近面按远近合成。
  const tex=blank(64,64);for(let p=0;p<tex.data.length;p+=4)tex.data.set(p/4%64<32?[255,0,0,255]:[0,255,0,128],p);
  const base=boxes('default',true)[0],offset=10*Math.sqrt(2)*Math.tan(Math.PI/6);
  const back={...base,position:[-10,28-offset,-10] as [number,number,number],uv:[32,0] as [number,number],overlay:true};
  assert.deepEqual(rasterize(tex,[base,back],128,128),rasterize(tex,[base],128,128));
  const front={...back,position:[10,28+offset,10] as [number,number,number]};const combined=rasterize(tex,[base,front],128,128);
  assert(combined.data.some((v,p)=>p%4===1&&v>0));
  assert.equal(avatar3d(tex,128).height,128);assert.equal(body3d(tex,'slim',256).height,256);
});
test('黄金图逐像素回归，全部黄金合计小于 1MB',async()=>{
  let total=0;const output=await renders();assert.equal(Object.keys(output).length,31);
  for(const [name,img]of Object.entries(output)){const b=await readFile(`golden/${name}`);total+=b.length;assert.deepEqual(decode(b),img,name);}assert(total<1024*1024);
});
test('无损 WebP exact 保留 alpha=0 的 RGB（sharp 解码交叉验证）',async()=>{
  const i=samplePng(6,8).expected;i.data.set([12,34,56,0],0);const b=await encodeWebp(i);const {data,info}=await sharp(b).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(info.width,i.width);assert.deepEqual(new Uint8Array(data),i.data);assert.equal(pixelHash(decode(encodePng(i))),pixelHash(i));
});
