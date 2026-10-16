import { readFileSync } from 'node:fs';
import { decode as fastDecode } from 'fast-png';
import { PNG } from 'pngjs';
import { decode,probe,pixelHash } from './png.ts';
const [mode,path]=process.argv.slice(2),bytes=readFileSync(path);
const start=performance.now();let accepted=false,error='',hash='';
try{
  if(mode==='probe')probe(bytes);
  else if(mode==='raw-fast')fastDecode(bytes);
  else if(mode==='raw-pngjs')PNG.sync.read(bytes);
  else hash=pixelHash(decode(bytes,mode==='safe-fast'?'fast-png':'pngjs'));
  accepted=true;
}catch(e){error=String(e instanceof Error?e.message:e);}
console.log(JSON.stringify({accepted,error,hash,ms:performance.now()-start,maxRSSKiB:process.resourceUsage().maxRSS}));
