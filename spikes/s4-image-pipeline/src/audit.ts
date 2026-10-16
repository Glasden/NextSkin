import { readFile,readdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const packages=[];const problems:string[]=[];
async function scan(path:string):Promise<void>{for(const e of await readdir(path,{withFileTypes:true})){if(e.name==='node_modules')continue;const p=join(path,e.name);if(e.isDirectory())await scan(p);else if(e.name.endsWith('.node')||e.name==='binding.gyp')problems.push(p);}}
for(const [path,meta]of Object.entries(lock.packages) as [string,{dev?:boolean;version?:string;optional?:boolean}][]){
  if(!path||meta.dev)continue;
  const pkg=JSON.parse(await readFile(`${path}/package.json`,'utf8'));
  const scripts=Object.fromEntries(Object.entries(pkg.scripts??{}).filter(([key])=>['preinstall','install','postinstall'].includes(key)));
  if(Object.keys(scripts).length)problems.push(`${path}: ${JSON.stringify(scripts)}`);
  await scan(path);packages.push({name:pkg.name,version:pkg.version,scripts});
}
const result={packages,problems};await writeFile('out/audit.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(problems.length)process.exitCode=1;
