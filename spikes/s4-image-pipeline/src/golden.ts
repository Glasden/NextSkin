import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { decode,encodePng,type Image,validate } from './png.ts';
import { avatar2d,avatar3d,body3d,preview2d,capePreview,inferModel } from './render.ts';
export async function renders():Promise<Record<string,Image>>{
  const manifest=JSON.parse(await readFile(new URL('./real-manifest.json',import.meta.url),'utf8'));
  const out:Record<string,Image>={};
  for(const name of Object.keys(manifest)){
    const image=decode(await readFile(`fixtures/real/${name}`)),stem=name.replace('.png','');
    if(name.includes('cape')){out[`${stem}-cape.png`]=capePreview(image,128);continue;}
    try{validate(image,'skin');}catch{continue;}
    const model=inferModel(image);out[`${stem}-avatar2d.png`]=avatar2d(image,64);out[`${stem}-avatar3d.png`]=avatar3d(image,128);out[`${stem}-body3d.png`]=body3d(image,model,256);out[`${stem}-preview2d.png`]=preview2d(image,model,256);
  }
  return out;
}
if(process.argv[1]?.endsWith('/golden.ts')){await mkdir('golden',{recursive:true});let total=0;for(const [name,image]of Object.entries(await renders())){const b=encodePng(image);total+=b.length;await writeFile(`golden/${name}`,b);}console.log(`黄金 PNG: ${total} 字节（仅显式 npm run golden 更新）`);}
