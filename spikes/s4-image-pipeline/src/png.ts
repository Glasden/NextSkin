import { createHash } from 'node:crypto';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { PNG } from 'pngjs';
import { decode as fastDecode, encode as fastEncode } from 'fast-png';

export interface Image { width: number; height: number; data: Uint8Array }
export interface Header { width: number; height: number; depth: number; colorType: number; interlace: number }
export const signature = Buffer.from([137,80,78,71,13,10,26,10]);
export const passes = [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
export const channels = [1,0,3,1,2,0,4];
export function probe(input: Uint8Array): Header {
  const b = Buffer.from(input.buffer,input.byteOffset,input.byteLength);
  if (b.length < 33 || !b.subarray(0,8).equals(signature) || b.readUInt32BE(8)!==13 || b.toString('ascii',12,16)!=='IHDR') throw Error('不是 PNG 或 IHDR 不在首位');
  const h = {width:b.readUInt32BE(16),height:b.readUInt32BE(20),depth:b[24],colorType:b[25],interlace:b[28]};
  const legal: Record<number,number[]> = {0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
  if (!h.width || !h.height || !legal[h.colorType]?.includes(h.depth) || b[26] || b[27] || h.interlace>1) throw Error('无效 IHDR');
  return h;
}
export function chunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  const b=Buffer.alloc(data.length+12); b.writeUInt32BE(data.length); b.write(type,4); b.set(data,8); b.writeUInt32BE(crc32(b.subarray(4,-4)),b.length-4); return b;
}
export interface Chunk { type: string; data: Buffer; bytes: Buffer }
export function chunks(input: Uint8Array): Chunk[] {
  const b=Buffer.from(input); const out: Chunk[]=[]; let end=false;
  for(let p=8;p<b.length;){
    if(out.length>=4096)throw Error('PNG 块数超过 4096');
    if(p+12>b.length)throw Error('截断块'); const n=b.readUInt32BE(p);
    if(n>b.length-p-12)throw Error('截断块'); const bytes=b.subarray(p,p+n+12);const type=b.toString('ascii',p+4,p+8);
    if(!/^[A-Za-z]{4}$/.test(type)||type[2]!==type[2].toUpperCase())throw Error('无效块类型');
    if(crc32(bytes.subarray(4,-4))!==bytes.readUInt32BE(n+8))throw Error(`CRC 错误: ${type}`);
    out.push({type,data:b.subarray(p+8,p+8+n),bytes});p+=n+12;
    if(type==='IEND'){if(n)throw Error('无效 IEND');end=true;break;}
  }
  if(!end)throw Error('缺 IEND'); return out;
}
export function filteredSize(h: Header): number {
  const ps=h.interlace?passes:[[0,0,1,1]];let n=0;
  for(const [x,y,dx,dy]of ps){const w=Math.max(0,Math.ceil((h.width-x)/dx)),ht=Math.max(0,Math.ceil((h.height-y)/dy));if(w&&ht)n+=(Math.ceil(w*channels[h.colorType]*h.depth/8)+1)*ht;}
  return n;
}
// 先限制输入、像素和实际解压量，再将元数据剥离，避免库解析压缩附加块。
export function guard(input: Uint8Array, maxWidth=1024, maxHeight=1024): {header: Header; clean: Buffer; list: Chunk[]} {
  if(input.byteLength>16*1024*1024)throw Error('输入超过 16 MiB');
  const header=probe(input);
  if(header.width>maxWidth||header.height>maxHeight)throw Error('宽高超过上限');
  const list=chunks(input);let idat=false,ended=false;let ihdr=0,plte=0,trns=0;
  for(const c of list){
    if(c.type==='IHDR'&&++ihdr!==1)throw Error('重复 IHDR');
    if(c.type==='PLTE'&&(idat||++plte!==1||!c.data.length||c.data.length%3||c.data.length>768))throw Error('无效 PLTE');
    if(c.type==='tRNS'&&(idat||++trns!==1||(header.colorType===3&&!plte)))throw Error('无效 tRNS');
    if(c.type==='IDAT'){if(ended)throw Error('IDAT 不连续');idat=true;}else if(idat)ended=true;
    if(c.type[0]===c.type[0].toUpperCase()&&!['IHDR','PLTE','IDAT','IEND'].includes(c.type))throw Error('未知关键块');
  }
  if(!idat||header.colorType===3&&!plte)throw Error('缺 IDAT/PLTE');
  const t=list.find(c=>c.type==='tRNS')?.data;
  if(t&& !((header.colorType===0&&t.length===2)||(header.colorType===2&&t.length===6)||(header.colorType===3&&t.length<=list.find(c=>c.type==='PLTE')!.data.length/3)))throw Error('无效 tRNS 长度');
  const expected=filteredSize(header);
  if(expected>9*1024*1024)throw Error('解压预算超限');
  const raw=inflateSync(Buffer.concat(list.filter(c=>c.type==='IDAT').map(c=>c.data)),{maxOutputLength:expected});
  if(raw.length!==expected)throw Error('扫描行长度不符');
  const clean=Buffer.concat([signature,...list.filter(c=>['IHDR','PLTE','tRNS','IDAT','IEND'].includes(c.type)).map(c=>c.bytes)]);
  return {header,clean,list};
}
export type Decoder = 'pngjs'|'fast-png';
export function decode(input: Uint8Array, decoder: Decoder='pngjs', maxWidth=1024, maxHeight=1024): Image {
  const {header:h,clean,list}=guard(input,maxWidth,maxHeight);
  const n=h.width*h.height, data=new Uint8Array(n*4);
  if(decoder==='pngjs'){
    // pngjs 默认 tRNS 会把透明 RGB 清零，默认 16 位会四舍五入；两者都不符合游戏。
    const source=h.colorType===0||h.colorType===2?Buffer.concat([signature,...list.filter(c=>['IHDR','PLTE','IDAT','IEND'].includes(c.type)).map(c=>c.bytes)]):clean;
    const p=PNG.sync.read(source,{skipRescale:true}); const t=list.find(c=>c.type==='tRNS')?.data;
    for(let i=0;i<n;i++){
      for(let c=0;c<4;c++)data[i*4+c]=h.depth===16?p.data[i*4+c]>>>8:h.colorType===3?p.data[i*4+c]:Math.round(p.data[i*4+c]*255/((1<<h.depth)-1));
      if(t&&(h.colorType===0||h.colorType===2)){
        const match=h.colorType===0?p.data[i*4]===t.readUInt16BE(0):[0,1,2].every(c=>p.data[i*4+c]===t.readUInt16BE(c*2));
        if(match)data[i*4+3]=0;
      }
    }
  }else{
    const p=fastDecode(clean,{checkCrc:true}); const t=p.transparency; const cc=p.channels;
    const sample=(i:number,c:number)=>{
      if(h.depth>=8)return p.data[i*cc+c];
      const row=Math.floor(i/h.width),x=i%h.width,bit=x*h.depth;
      return (p.data[row*Math.ceil(h.width*h.depth/8)+(bit>>>3)]>>>(8-h.depth-bit%8))&((1<<h.depth)-1);
    };
    const cv=(v:number)=>h.depth===16?v>>>8:h.depth===8?v:Math.round(v*255/((1<<h.depth)-1));
    for(let i=0;i<n;i++){
      if(h.colorType===3){const col=p.palette?.[sample(i,0)];if(!col)throw Error('调色板索引越界');data.set([col[0],col[1],col[2],col[3]??255],i*4);continue;}
      const r=sample(i,0),g=cc>1?sample(i,1):r,b=cc>2?sample(i,2):r;
      const gray=h.colorType===0||h.colorType===4,pixel=i*4;
      const transparent=t&&t.length>0&&(gray?t[0]===r:t[0]===r&&t[1]===g&&t[2]===b);
      data[pixel]=cv(r);data[pixel+1]=cv(gray?r:g);data[pixel+2]=cv(gray?r:b);
      data[pixel+3]=transparent?0:h.colorType===4?cv(g):h.colorType===6?cv(sample(i,3)):255;
    }
  }
  return {width:h.width,height:h.height,data};
}
function paeth(a:number,b:number,c:number):number{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
// 固定选择绝对残差之和最小的滤波器，同分选择编号小者；zlib level=6。
export function encodePng(image: Image, level=6): Buffer {
  const {width:w,height:h,data}=image; if(data.length!==w*h*4)throw Error('RGBA 长度不符');
  const stride=w*4,raw=Buffer.alloc((stride+1)*h),candidates=Array.from({length:5},()=>new Uint8Array(stride));
  for(let y=0;y<h;y++){
    const score=[0,0,0,0,0];
    for(let x=0;x<stride;x++){
      const i=y*stride+x,v=data[i],a=x>=4?data[i-4]:0,b=y?data[i-stride]:0,c=y&&x>=4?data[i-stride-4]:0;
      const predictions=[0,a,b,(a+b)>>>1,paeth(a,b,c)];
      for(let f=0;f<5;f++){const d=(v-predictions[f])&255;candidates[f][x]=d;score[f]+=Math.min(d,256-d);}
    }
    const f=score.indexOf(Math.min(...score));raw[y*(stride+1)]=f;raw.set(candidates[f],y*(stride+1)+1);
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([signature,chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level})),chunk('IEND')]);
}
export function encodeFast(i:Image,level:0|1|6|9=6):Buffer{return Buffer.from(fastEncode({...i,depth:8,channels:4},{zlib:{level}}));}
export function encodePngjs(i:Image,level=6):Buffer{return PNG.sync.write(Object.assign(new PNG({width:i.width,height:i.height}),{data:Buffer.from(i.data)}),{deflateLevel:level,colorType:6,inputColorType:6});}
export const sha=(b:Uint8Array):string=>createHash('sha256').update(b).digest('hex');
export function pixelHash(i:Image):string{const h=Buffer.alloc(8);h.writeUInt32BE(i.width);h.writeUInt32BE(i.height,4);return createHash('sha256').update(h).update(i.data).digest('hex');}
export function validate(i:Image,kind:'skin'|'cape',maxWidth=1024):Image{
  const {width:w,height:h}=i;if(w>maxWidth)throw Error('宽超过上限');
  if(kind==='skin'){if(w%64||h!==w&&h!==w/2)throw Error('无效皮肤尺寸');return i;}
  if(w%64===0&&h%32===0&&w/64===h/32)return i;
  if(w%22===0&&h%17===0&&w/22===h/17){const k=w/22;if(k*64>maxWidth)throw Error('补边后超限');const out={width:64*k,height:32*k,data:new Uint8Array(64*k*32*k*4)};for(let y=0;y<h;y++)out.data.set(i.data.subarray(y*w*4,(y+1)*w*4),y*out.width*4);return out;}
  throw Error('无效披风尺寸');
}
export function upload(input:Uint8Array,kind:'skin'|'cape'='skin',maxWidth=1024){const image=validate(decode(input,'pngjs',maxWidth,maxWidth),kind,maxWidth),png=encodePng(image);return {image,png,hashA:sha(png),hashB:pixelHash(image)};}
