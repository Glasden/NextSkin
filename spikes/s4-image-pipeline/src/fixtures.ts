import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decode,encodePng,sha } from './png.ts';
import { resize,extract } from './render.ts';
export const commit='84906e983a2cf325f33f515b9a71c871f799054b';
export async function fixtures(){
  for(const path of ['fixtures/real','fixtures/synthetic','out','golden'])await mkdir(path,{recursive:true});
  const manifest:Record<string,string>=JSON.parse(await readFile(new URL('./real-manifest.json',import.meta.url),'utf8'));
  for(const [name,hash]of Object.entries(manifest)){
    let b:Buffer;try{b=await readFile(`fixtures/real/${name}`);}catch{const r=await fetch(`https://raw.githubusercontent.com/bs-community/skinview3d/${commit}/examples/public/img/${name}`);if(!r.ok)throw Error(`下载 ${name}: ${r.status}`);b=Buffer.from(await r.arrayBuffer());}
    if(sha(b)!==hash)throw Error(`sha256 不匹配: ${name}`);await writeFile(`fixtures/real/${name}`,b);
  }
  const source=decode(await readFile('fixtures/real/hatsune_miku.png'));
  let state=0x12345678;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
  for(const [w,h]of [[64,32],[64,64],[128,128],[256,256],[512,512],[1024,1024]]){
    const image=resize(h===w/2?extract(source,0,0,source.width,source.height/2):source,w,h);await writeFile(`fixtures/synthetic/skin-${w}x${h}.png`,encodePng(image));
    for(let p=0;p<image.data.length;p++)image.data[p]=random()&255;
    await writeFile(`fixtures/synthetic/noise-${w}x${h}.png`,encodePng(image));
  }
  console.log('11 个固定提交 SHA256 校验通过；12 个确定性合成材质已生成');
}
if(process.argv[1]===fileURLToPath(import.meta.url))await fixtures();
