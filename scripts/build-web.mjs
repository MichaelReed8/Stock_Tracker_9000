import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

await mkdir('dist/web/web', { recursive: true });
await build({ entryPoints: ['web/app.tsx'], bundle: true, minify: true, format: 'esm', target: 'safari16.4', outfile: 'dist/web/web/app.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
for (const name of ['index.html', 'manifest.webmanifest', 'icon.svg', 'sw.js']) await copyFile(`web/${name}`, `dist/web/web/${name}`);
// Native, deterministic PNG icon for iOS Home Screen (no external asset service).
const size = 192, raw = Buffer.alloc(size * (1 + size * 4));
const lines = [[49,116,80,84],[80,84,105,97],[105,97,145,54],[119,54,145,54],[145,54,145,80]];
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  let color = [22,44,39];
  const line = (x1,y1,x2,y2) => { const t = Math.max(0, Math.min(1, ((x-x1)*(x2-x1)+(y-y1)*(y2-y1))/((x2-x1)**2+(y2-y1)**2))); return Math.hypot(x-x1-t*(x2-x1),y-y1-t*(y2-y1)) < 5; };
  if (line(37,63,37,133) || line(37,133,156,133)) color = [106,140,127];
  if (lines.some(l => line(...l))) color = [183,239,190];
  const i = y*(size*4+1)+1+x*4; raw.set([...color,255],i);
}
const crc = data => { let c = 0xffffffff; for (const b of data) { c ^= b; for(let i=0;i<8;i++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (c^0xffffffff)>>>0; };
const chunk = (type, data) => { const name=Buffer.from(type), n=Buffer.alloc(4), sum=Buffer.alloc(4); n.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([name,data]))); return Buffer.concat([n,name,data,sum]); };
const header=Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
await writeFile('dist/web/web/icon.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
await build({ entryPoints: ['src/cloud/web-handler.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, outfile: 'dist/web/web-handler.mjs' });
console.log('Built React PWA and read-only Lambda. No credential files loaded.');
