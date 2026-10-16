// sharp 只在验证/基准脚本引入，生产模块不依赖它。
import sharp from 'sharp';
import { type Image } from './png.ts';
import { prepareSkin, type Model } from './render.ts';
const raw=(i:Image)=>({raw:{width:i.width,height:i.height,channels:4 as const}});
async function crop(i:Image,left:number,top:number,width:number,height:number){return sharp(i.data,raw(i)).extract({left,top,width,height}).raw().toBuffer();}
export async function referenceAvatar(skin:Image,size:number):Promise<Image>{
  const s=prepareSkin(skin),k=s.width/64,w=8*k;
  const base=await crop(s,8*k,8*k,w,w),hat=await crop(s,40*k,8*k,w,w);
  // composite 在 resize 之后执行；像素整数倍的结果与先叠再缩放一致。
  const composite=await sharp(base,{raw:{width:w,height:w,channels:4}}).composite([{input:hat,raw:{width:w,height:w,channels:4},blend:'over'}]).raw().toBuffer();
  const data=await sharp(composite,{raw:{width:w,height:w,channels:4}}).resize(size,size,{kernel:'nearest'}).raw().toBuffer();
  return {width:size,height:size,data};
}
export async function referenceFront(skin:Image,model:Model,height:number):Promise<Image>{
  const s=prepareSkin(skin),k=s.width/64,a=model==='slim'?3:4;
  // sx,sy,w,h,dx,dy,ox,oy；独立布局，避免与光栅器共享 UV 表。
  const rectangles=[[8,8,8,8,4,0,40,8],[20,20,8,12,4,8,20,36],[44,20,a,12,4-a,8,44,36],[36,52,a,12,12,8,52,52],[4,20,4,12,4,20,4,36],[20,52,4,12,8,20,4,52]];
  const layers:sharp.OverlayOptions[]=[];
  for(const [sx,sy,w,h,x,y,ox,oy]of rectangles){for(const [u,v]of [[sx,sy],[ox,oy]])layers.push({input:await crop(s,u*k,v*k,w*k,h*k),raw:{width:w*k,height:h*k,channels:4},left:x*k,top:y*k,blend:'over'});}
  const buf=await sharp({create:{width:16*k,height:32*k,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(layers).raw().toBuffer();
  const width=height/2;return {width,height,data:await sharp(buf,{raw:{width:16*k,height:32*k,channels:4}}).resize(width,height,{kernel:'nearest'}).raw().toBuffer()};
}
export async function sharpUpload(bytes:Buffer):Promise<Buffer>{return sharp(bytes,{limitInputPixels:1024*1024}).ensureAlpha().png({compressionLevel:6,adaptiveFiltering:true}).toBuffer();}
export async function referencePreview(skin:Image,model:Model,height:number):Promise<Image>{
  const s=prepareSkin(skin),k=s.width/64,a=model==='slim'?3:4;
  const rectangles=[
    [8,8,8,8,4,0,40,8],[20,20,8,12,4,8,20,36],[44,20,a,12,4-a,8,44,36],[36,52,a,12,12,8,52,52],[4,20,4,12,4,20,4,36],[20,52,4,12,8,20,4,52],
    [24,8,8,8,24,0,56,8],[32,20,8,12,24,8,32,36],[48+a,20,a,12,32,8,48+a,36],[40+a,52,a,12,24-a,8,56+a,52],[12,20,4,12,28,20,12,36],[28,52,4,12,24,20,12,52]
  ];
  const layers:sharp.OverlayOptions[]=[];
  for(const [sx,sy,w,h,x,y,ox,oy]of rectangles)for(const [u,v]of [[sx,sy],[ox,oy]])layers.push({input:await crop(s,u*k,v*k,w*k,h*k),raw:{width:w*k,height:h*k,channels:4},left:x*k,top:y*k,blend:'over'});
  const width=Math.round(height*40/32);const buf=await sharp({create:{width:40*k,height:32*k,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(layers).raw().toBuffer();
  return {width,height,data:await sharp(buf,{raw:{width:40*k,height:32*k,channels:4}}).resize(width,height,{kernel:'nearest'}).raw().toBuffer()};
}
