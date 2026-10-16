import { validate, type Image } from './png.ts';
export type Model='default'|'slim';
export const blank=(width:number,height:number):Image=>({width,height,data:new Uint8Array(width*height*4)});
export function extract(i:Image,x:number,y:number,w:number,h:number):Image{const o=blank(w,h);for(let r=0;r<h;r++)o.data.set(i.data.subarray(((y+r)*i.width+x)*4,((y+r)*i.width+x+w)*4),r*w*4);return o;}
export function resize(i:Image,width:number,height:number):Image{const o=blank(width,height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=(Math.min(i.height-1,Math.floor((y+0.5)*i.height/height))*i.width+Math.min(i.width-1,Math.floor((x+0.5)*i.width/width)))*4;o.data.set(i.data.subarray(p,p+4),(y*width+x)*4);}return o;}
// 标准 alpha over，使用 float32 归一化并截断到 RGBA8，与 libvips RGBA 路径一致。
export function over(d:Uint8Array,p:number,s:ArrayLike<number>,light=1):void{
  const f=Math.fround,a=f(s[3]/255);if(!a)return;const b=f(d[p+3]/255),t=f(1-a),oa=f(a+f(b*t));
  for(let c=0;c<3;c++){
    const src=f(f(s[c]*light/255)*a),dst=f(f(d[p+c]/255)*b);
    d[p+c]=Math.max(0,Math.min(255,Math.trunc(f(f(f(src+t*dst)/oa)*255))));
  }
  d[p+3]=Math.trunc(f(oa*255));
}
export function blit(d:Image,s:Image,x:number,y:number):void{for(let sy=0;sy<s.height;sy++)for(let sx=0;sx<s.width;sx++){if(x+sx<0||x+sx>=d.width||y+sy<0||y+sy>=d.height)continue;const p=(sy*s.width+sx)*4;over(d.data,((sy+y)*d.width+sx+x)*4,s.data.subarray(p,p+4));}}
function area(i:Image,r:number[],fn:(p:number)=>void){const k=i.width/64;const [x,y,w,h]=r.map(v=>v*k);for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)fn((yy*i.width+xx)*4);}
export function inferModel(i:Image):Model{
  if(i.height*2===i.width)return 'default';const points:number[]=[];
  for(const r of [[50,16,2,4],[54,20,2,12],[42,48,2,4],[46,52,2,12]])area(i,r,p=>points.push(p));
  if(points.some(p=>i.data[p+3]!==255)||[0,255].some(v=>points.every(p=>i.data[p]===v&&i.data[p+1]===v&&i.data[p+2]===v&&i.data[p+3]===255)))return 'slim';return 'default';
}
export function prepareSkin(source:Image):Image{
  // 资源预算已在解码/上传边界检查，此处只复查形状，不覆盖配置的宽度上限。
  validate(source,'skin',source.width);const o=blank(source.width,source.width);o.data.set(source.data);const k=o.width/64,old=source.height!==source.width;
  if(old){
    const copies=[[4,16,4,4,20,48],[8,16,4,4,24,48],[0,20,4,12,24,52],[4,20,4,12,20,52],[8,20,4,12,16,52],[12,20,4,12,28,52],[44,16,4,4,36,48],[48,16,4,4,40,48],[40,20,4,12,40,52],[44,20,4,12,36,52],[48,20,4,12,32,52],[52,20,4,12,44,52]];
    for(const c of copies){const [sx,sy,w,h,dx,dy]=c.map(v=>v*k);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=((sy+y)*o.width+sx+w-1-x)*4;o.data.set(o.data.subarray(p,p+4),((dy+y)*o.width+dx+x)*4);}}
    // 客户端旧格式规则：帽子矩形中无 alpha<128 的像素时整块清 alpha。
    let transparent=false;area(o,[32,0,32,32],p=>{if(o.data[p+3]<128)transparent=true;});
    if(!transparent)area(o,[32,0,32,32],p=>{o.data[p+3]=0;});
  }
  for(const r of [[0,0,32,16],[0,16,64,16],[16,48,32,16]])area(o,r,p=>{o.data[p+3]=255;});
  return o;
}
export function avatar2d(skin:Image,size:number):Image{const s=prepareSkin(skin),k=s.width/64;const face=extract(s,8*k,8*k,8*k,8*k);blit(face,extract(s,40*k,8*k,8*k,8*k),0,0);return resize(face,size,size);}
export interface Box {size:[number,number,number];position:[number,number,number];uv:[number,number];expand:number;overlay:boolean}
export function boxes(model:Model,headOnly=false):Box[]{
  const a=model==='slim'?3:4;
  const parts:[Box['size'],Box['position'],Box['uv'],Box['uv']][]=[[[8,8,8],[0,28,0],[0,0],[32,0]]];
  if(!headOnly)parts.push([[8,12,4],[0,18,0],[16,16],[16,32]],[[a,12,4],[-4-a/2,18,0],[40,16],[40,32]],[[a,12,4],[4+a/2,18,0],[32,48],[48,48]],[[4,12,4],[-2,6,0],[0,16],[0,32]],[[4,12,4],[2,6,0],[16,48],[0,48]]);
  return parts.flatMap(([size,position,uv,outer],index)=>[{size,position,uv,expand:0,overlay:false},{size,position,uv:outer,expand:index===0?0.5:0.25,overlay:true}]);
}
export const CAMERA={yaw:Math.PI/4,elevation:Math.PI/6,margin:4};
export const LIGHT={top:1,front:0.85,side:0.7};
type V=[number,number,number];
interface Face {o:V;u:V;v:V;uv:[number,number,number,number];light:number;overlay:boolean}
function faces(b:Box):Face[]{
  const [w,h,d]=b.size,[cx,cy,cz]=b.position,[tx,ty]=b.uv,e=b.expand;
  const x=cx-w/2-e,X=cx+w/2+e,y=cy-h/2-e,Y=cy+h/2+e,z=cz-d/2-e,Z=cz+d/2+e;
  const make=(o:V,u:V,v:V,uv:Face['uv'],light:number):Face=>({o,u,v,uv,light,overlay:b.overlay});
  return [make([x,Y,z],[X-x,0,0],[0,0,Z-z],[tx+d,ty,w,d],LIGHT.top),
    make([x,Y,Z],[X-x,0,0],[0,y-Y,0],[tx+d,ty+d,w,h],LIGHT.front),
    make([X,Y,Z],[0,0,z-Z],[0,y-Y,0],[tx+d+w,ty+d,d,h],LIGHT.side),
    make([x,Y,z],[0,0,Z-z],[0,y-Y,0],[tx,ty+d,d,h],LIGHT.side),
    make([X,Y,z],[x-X,0,0],[0,y-Y,0],[tx+w+2*d,ty+d,w,h],LIGHT.front),
    make([x,y,Z],[X-x,0,0],[0,0,z-Z],[tx+d+w,ty,w,d],LIGHT.side)];
}
const add=(a:V,b:V):V=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
function project([x,y,z]:V):V{const cy=Math.cos(CAMERA.yaw),sy=Math.sin(CAMERA.yaw),ce=Math.cos(CAMERA.elevation),se=Math.sin(CAMERA.elevation);return [x*cy-z*sy,-y*ce+(x*sy+z*cy)*se,y*se+(x*sy+z*cy)*ce];}
// 每面逆映射最近邻采样；透明片元逐像素按深度排序，支持背面和相交长方体。
export function rasterize(texture:Image,items:Box[],width:number,height:number):Image{
  const fs=items.flatMap(faces),verts=fs.flatMap(f=>[f.o,add(f.o,f.u),add(f.o,f.v),add(add(f.o,f.u),f.v)].map(project));
  const minX=Math.min(...verts.map(v=>v[0])),maxX=Math.max(...verts.map(v=>v[0])),minY=Math.min(...verts.map(v=>v[1])),maxY=Math.max(...verts.map(v=>v[1]));
  const scale=Math.min((width-CAMERA.margin*2)/(maxX-minX),(height-CAMERA.margin*2)/(maxY-minY));
  const ox=(width-(maxX-minX)*scale)/2-minX*scale,oy=(height-(maxY-minY)*scale)/2-minY*scale;
  const out=blank(width,height),depth=new Float64Array(width*height).fill(-Infinity);
  type Fragment={z:number;c:[number,number,number,number];light:number};const transparent:(Fragment[]|undefined)[]=new Array(width*height);
  const draw=(f:Face)=>{
    const o=project(f.o),pu=project(f.u),pv=project(f.v),det=pu[0]*pv[1]-pv[0]*pu[1];if(Math.abs(det)<1e-9)return;
    const cs=[[0,0],[1,0],[0,1],[1,1]].map(([u,v])=>[ox+(o[0]+u*pu[0]+v*pv[0])*scale,oy+(o[1]+u*pu[1]+v*pv[1])*scale]);
    const x0=Math.max(0,Math.floor(Math.min(...cs.map(p=>p[0])))),x1=Math.min(width,Math.ceil(Math.max(...cs.map(p=>p[0]))));
    const y0=Math.max(0,Math.floor(Math.min(...cs.map(p=>p[1])))),y1=Math.min(height,Math.ceil(Math.max(...cs.map(p=>p[1]))));
    const k=texture.width/64;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const rx=(x+0.5-ox)/scale-o[0],ry=(y+0.5-oy)/scale-o[1],u=(rx*pv[1]-ry*pv[0])/det,v=(pu[0]*ry-pu[1]*rx)/det;
      if(u<0||u>=1||v<0||v>=1)continue;
      const z=o[2]+pu[2]*u+pv[2]*v,p=y*width+x;
      if(z<depth[p]-1e-8)continue;
      const tx=Math.floor((f.uv[0]+u*f.uv[2])*k),ty=Math.floor((f.uv[1]+v*f.uv[3])*k),q=(ty*texture.width+tx)*4;
      const c:[number,number,number,number]=[texture.data[q],texture.data[q+1],texture.data[q+2],texture.data[q+3]];if(!c[3])continue;
      if(f.overlay){(transparent[p]??=[]).push({z,c,light:f.light});}else{depth[p]=z;for(let j=0;j<3;j++)out.data[p*4+j]=Math.round(c[j]*f.light);out.data[p*4+3]=255;}
    }
  };
  fs.filter(f=>!f.overlay).forEach(draw);fs.filter(f=>f.overlay).forEach(draw);
  for(let p=0;p<transparent.length;p++)for(const f of transparent[p]?.sort((a,b)=>a.z-b.z)??[])if(f.z>=depth[p]-1e-8)over(out.data,p*4,f.c,f.light);
  return out;
}
export function avatar3d(skin:Image,size:number):Image{return rasterize(prepareSkin(skin),boxes('default',true),size,size);}
export function body3d(skin:Image,model:Model,height:number):Image{return rasterize(prepareSkin(skin),boxes(model),Math.ceil(height*0.75),height);}
export function preview2d(skin:Image,model:Model,height:number):Image{
  const s=prepareSkin(skin),k=s.width/64,out=blank(40*k,32*k);
  const parts=boxes(model).filter(b=>!b.overlay);const layers=boxes(model).filter(b=>b.overlay);
  for(let view=0;view<2;view++)for(let j=0;j<parts.length;j++){
    const b=parts[j],[w,h,d]=b.size,[x,y]=b.position;
    const dx=(view===0?8+x-w/2:28-x-w/2)*k,dy=(32-y-h/2)*k;
    for(const layer of [b,layers[j]]){
      const [u,v]=layer.uv;const sx=view===0?u+d:u+w+2*d;
      blit(out,extract(s,sx*k,(v+d)*k,w*k,h*k),dx,dy);
    }
  }
  return resize(out,Math.round(height*40/32),height);
}
export function capePreview(cape:Image,height:number):Image{const c=validate(cape,'cape',Infinity),k=c.width/64;return resize(extract(c,k,k,10*k,16*k),Math.round(height*10/16),height);}
