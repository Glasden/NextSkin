import { deflateSync } from 'node:zlib';
import { chunk,signature,passes,channels,type Header,type Image } from './png.ts';
export interface Sample {name:string;bytes:Buffer;expected?:Image;valid:boolean}
// 独立生成所有合法颜色类型/位深/隔行组合，包含非零透明 RGB 和 16 位舍入边界。
export function samplePng(colorType:number,depth:number,interlace=0,width=64,height=64):{bytes:Buffer;expected:Image}{
  const h:Header={width,height,depth,colorType,interlace},cc=channels[colorType],max=2**depth-1;
  const palette=[[17,35,51,0],[200,70,33,127],[0,255,64,255],[255,0,128,255]].slice(0,Math.min(2**depth,4));
  const values=(x:number,y:number)=>{
    if(colorType===3)return [(x+y)%palette.length];
    return Array.from({length:cc},(_,c)=>((x*257+y*515+c*129+129)% (max+1)));
  };
  const rows:Buffer[]=[];const ps=interlace?passes:[[0,0,1,1]];
  for(const [sx,sy,dx,dy]of ps){const pw=Math.max(0,Math.ceil((width-sx)/dx));if(!pw)continue;
    for(let y=sy;y<height;y+=dy){const row=Buffer.alloc(1+Math.ceil(pw*cc*depth/8));let bit=0;
      for(let x=sx;x<width;x+=dx)for(const v of values(x,y)){
        if(depth===16){row.writeUInt16BE(v,1+(bit>>>3));}else if(depth===8)row[1+(bit>>>3)]=v;else row[1+(bit>>>3)]|=v<<(8-depth-bit%8);bit+=depth;
      }rows.push(row);
    }
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=depth;ihdr[9]=colorType;ihdr[12]=interlace;
  const extra:Buffer[]=[];const transparent=values(0,0);
  if(colorType===3){extra.push(chunk('PLTE',Buffer.from(palette.flatMap(p=>p.slice(0,3)))),chunk('tRNS',Buffer.from(palette.map(p=>p[3]))));}
  if(colorType===0||colorType===2){const t=Buffer.alloc(cc*2);transparent.forEach((v,i)=>t.writeUInt16BE(v,i*2));extra.push(chunk('tRNS',t));}
  const data=new Uint8Array(width*height*4);const cv=(v:number)=>depth===16?v>>>8:Math.round(v*255/max);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const v=values(x,y),p=(y*width+x)*4;
    if(colorType===3){data.set(palette[v[0]],p);continue;}
    const gray=colorType===0||colorType===4,rgb=gray?[v[0],v[0],v[0]]:v.slice(0,3);
    const trans=(colorType===0||colorType===2)&&v.every((n,c)=>n===transparent[c]);
    data.set([...rgb.map(cv),trans?0:colorType===4?cv(v[1]):colorType===6?cv(v[3]):255],p);
  }
  return {bytes:Buffer.concat([signature,chunk('IHDR',ihdr),...extra,chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND')]),expected:{width,height,data}};
}
export function formats():Sample[]{
  const out:Sample[]=[];
  for(const [ct,depths]of [[0,[1,2,4,8,16]],[2,[8,16]],[3,[1,2,4,8]],[4,[8,16]],[6,[8,16]]] as const)for(const d of depths)for(const a of [0,1])out.push({name:`ct${ct}-d${d}-${a?'adam7':'plain'}`,...samplePng(ct,d,a),valid:true});
  return out;
}
export function corpus():Sample[]{
  const base=samplePng(6,8).bytes;const ihdr=base.subarray(8,33);const idat=base.subarray(33,-12),iend=chunk('IEND');
  const huge=Buffer.from(ihdr.subarray(8,-4));huge.writeUInt32BE(100000);huge.writeUInt32BE(100000,4);
  const bomb=deflateSync(Buffer.alloc(200*1024*1024),{level:9});
  const badCrc=Buffer.from(base);badCrc[badCrc.length-1]^=1;
  const meta=[chunk('tEXt',Buffer.from('comment\0hello')),chunk('zTXt',Buffer.concat([Buffer.from('comment\0\0'),deflateSync(Buffer.from('hello'))])),chunk('iTXt',Buffer.from('comment\0\0\0\0\0hello')),chunk('iCCP',Buffer.concat([Buffer.from('profile\0\0'),deflateSync(Buffer.from('not applied'))])),chunk('gAMA',Buffer.from([0,0,177,143])),chunk('eXIf',Buffer.from('Exif payload'))];
  const actl=Buffer.alloc(8);actl.writeUInt32BE(2);const fctl=Buffer.alloc(26);fctl.writeUInt32BE(64,4);fctl.writeUInt32BE(64,8);fctl.writeUInt16BE(1,20);fctl.writeUInt16BE(10,22);
  const second=Buffer.from(fctl);second.writeUInt32BE(1);const seq=Buffer.alloc(4);seq.writeUInt32BE(2);const frame=Buffer.alloc(64*64*4+64);for(let y=0;y<64;y++)for(let x=0;x<64;x++){const p=y*257+1+x*4;frame[p]=255;frame[p+3]=255;}
  return [
    {name:'huge-IHDR',bytes:Buffer.concat([signature,chunk('IHDR',huge),chunk('tEXt',Buffer.from('note\0'+'x'.repeat(128))),chunk('IDAT',deflateSync(Buffer.alloc(64*64*4+64))),iend]),valid:false},
    {name:'IDAT-200MiB',bytes:Buffer.concat([signature,ihdr,chunk('IDAT',bomb),iend]),valid:false},
    {name:'Adam7-IDAT-200MiB',bytes:Buffer.concat([signature,chunk('IHDR',Buffer.from([...ihdr.subarray(8,-5),1])),chunk('IDAT',bomb),iend]),valid:false},
    {name:'bad-CRC',bytes:badCrc,valid:false},{name:'truncated',bytes:base.subarray(0,-7),valid:false},
    {name:'missing-IEND',bytes:base.subarray(0,-12),valid:false},{name:'IDAT-before-IHDR',bytes:Buffer.concat([signature,idat,ihdr,iend]),valid:false},
    {name:'trailing-data',bytes:Buffer.concat([base,Buffer.from('<script>arbitrary trailing payload</script>')]),expected:samplePng(6,8).expected,valid:true},
    {name:'JPEG',bytes:Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1,255,217]),valid:false},
    {name:'GIF',bytes:Buffer.from('GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff!\xf9\x04\x01\0\0\0\0,\0\0\0\0\x01\0\x01\0\0\x02\x02D\x01\0;','latin1'),valid:false},
    {name:'SVG',bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>'),valid:false},{name:'empty',bytes:Buffer.alloc(0),valid:false},
    {name:'metadata-and-tail',bytes:Buffer.concat([signature,ihdr,...meta,idat,iend,Buffer.from('extra')]),expected:samplePng(6,8).expected,valid:true},
    {name:'iCCP-200MiB',bytes:Buffer.concat([signature,ihdr,chunk('iCCP',Buffer.concat([Buffer.from('bomb\0\0'),bomb])),idat,iend]),expected:samplePng(6,8).expected,valid:true},
    {name:'APNG-default',bytes:Buffer.concat([signature,ihdr,chunk('acTL',actl),chunk('fcTL',fctl),idat,chunk('fcTL',second),chunk('fdAT',Buffer.concat([seq,deflateSync(frame)])),iend]),expected:samplePng(6,8).expected,valid:true},
    ...formats()
  ];
}
