import { mkdir,writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { corpus } from './corpus.ts';
import { pixelHash } from './png.ts';
await mkdir('out/corpus',{recursive:true});
const rows=[];
for(const s of corpus()){
  if(s.name==='JPEG')s.bytes=await sharp({create:{width:64,height:64,channels:3,background:{r:20,g:30,b:40}}}).jpeg().toBuffer();
  const path=`out/corpus/${s.name}.png`;await writeFile(path,s.bytes);
  for(const mode of ['raw-fast','raw-pngjs','safe-fast','safe-pngjs']){
    const child=spawnSync(process.execPath,['--import','tsx','src/robustness-child.ts',mode,path],{timeout:5000,encoding:'utf8',maxBuffer:1024*1024});
    let result;try{result=JSON.parse(child.stdout.trim());}catch{result={accepted:false,error:child.error?.message??child.stderr.slice(0,200),ms:5000,maxRSSKiB:null};}
    rows.push({name:s.name,mode,valid:s.valid,inputBytes:s.bytes.length,exitCode:child.status,signal:child.signal,...result,...(s.expected&&mode.startsWith('safe')?{pixelsCorrect:result.hash===pixelHash(s.expected)}:{})});
  }
  console.log(s.name);
}
const output=JSON.stringify({node:process.version,rows},null,2);await writeFile('out/robustness.json',output);await writeFile(`out/robustness-node${process.versions.node.split('.')[0]}.json`,output);
