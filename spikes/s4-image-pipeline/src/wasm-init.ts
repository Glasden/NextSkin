import { initWebp } from './webp.ts';
const before=process.memoryUsage().rss,result=await initWebp();
console.log(JSON.stringify({node:process.version,...result,rssBefore:before,rssAfter:process.memoryUsage().rss,maxRSSKiB:process.resourceUsage().maxRSS}));
