import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
const root = fileURLToPath(new URL('../..', import.meta.url));
const config = JSON.parse(await readFile(path.join(root,'datasets/v1/dataset.json'),'utf8'));
const token = process.env.DATASET_GITHUB_TOKEN;
let bytes;
if (process.env.EAW_DATASET_ARCHIVE) {
  bytes = await readFile(process.env.EAW_DATASET_ARCHIVE);
} else {
  const headers = { 'User-Agent': 'environment-awareness-viewer', Accept: 'application/vnd.github+json', ...(token ? {Authorization: `Bearer ${token}`} : {}) };
  const metadata = await fetch(`https://api.github.com/repos/${config.repository}/releases/tags/${config.release}`, {headers, signal:AbortSignal.timeout(30000)});
  if (!metadata.ok) throw Error(`Dataset release request failed: ${metadata.status}. Private releases require DATASET_GITHUB_TOKEN during build.`);
  const release = await metadata.json();
  const asset = release.assets.find(a=>a.name===config.asset);
  if (!asset) throw Error('Pinned dataset asset is missing');
  const download = await fetch(asset.url, {headers:{...headers,Accept:'application/octet-stream'},signal:AbortSignal.timeout(120000)});
  if (!download.ok) throw Error(`Dataset download failed: ${download.status}`);
  bytes = Buffer.from(await download.arrayBuffer());
}
if (bytes.length!==config.bytes || createHash('sha256').update(bytes).digest('hex')!==config.sha256) throw Error('Dataset checksum mismatch');
const data=JSON.parse(gunzipSync(bytes,{maxOutputLength:256*1024*1024}).toString());
if(data.version!==1 || data.runs.length!==config.sessions || data.index.runs.length!==config.sessions) throw Error('Dataset count/version mismatch');
const safeKey=key=>typeof key==='string' && key.split('/').every(part=>/^[A-Za-z0-9._-]+$/.test(part)&&part!=='.'&&part!=='..');
const keys=new Set();
for (const run of data.runs) {
 if(!safeKey(run.key)||keys.has(run.key)||!run.summary.grade.valid||run.summary.grade.censored||run.summary.termination.reason!=='agent_finished')throw Error('Invalid dataset session');
 keys.add(run.key);
}
const indexKeys=new Set(data.index.runs.map(r=>r.key));
if(indexKeys.size!==keys.size || [...indexKeys].some(key=>!keys.has(key)))throw Error('Dataset index mismatch');
const out=path.join(root,'viewer/public/data');
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
await writeFile(path.join(out,'index.json'),JSON.stringify(data.index));
for(const run of data.runs){const f=path.join(out,'runs',run.key+'.json');await mkdir(path.dirname(f),{recursive:true});await writeFile(f,JSON.stringify(run));}
console.log(`Verified and installed ${data.runs.length} dataset sessions`);
