import { readFile } from 'node:fs/promises';
import encode,{ init } from '@jsquash/webp/encode.js';
import type { Image } from './png.ts';
let ready:Promise<unknown>|undefined;
export async function initWebp(){
  const start=performance.now(),rss=process.memoryUsage().rss;
  // 传 wasmBinary 避免 Node fetch(file:)；SIMD 探测与包的 JS 包装保持一致。
  ready??=(async()=>{const {simd}=await import('wasm-feature-detect');const name=await simd()?'webp_enc_simd.wasm':'webp_enc.wasm';const wasmBinary=await readFile(new URL(`../node_modules/@jsquash/webp/codec/enc/${name}`,import.meta.url));await init({wasmBinary} as Parameters<typeof init>[0]);})();
  await ready;return {ms:performance.now()-start,rssDelta:process.memoryUsage().rss-rss};
}
export async function encodeWebp(image:Image):Promise<Buffer>{await initWebp();return Buffer.from(await encode({width:image.width,height:image.height,data:new Uint8ClampedArray(image.data),colorSpace:'srgb'},{lossless:1,exact:1,near_lossless:100,quality:75,method:4}));}
