import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extractBinary } from './archive.js';

export const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const defaultRoot = () => path.join(os.homedir(), '.dsh-jand');
export function target(platform = process.platform, arch = process.arch) {
  if (!['darwin','win32','linux'].includes(platform) || !['arm64','x64'].includes(arch)) throw new Error(`Unsupported kernel target: ${platform}/${arch}`);
  return `${platform}-${arch}`;
}
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const shippedManifest=()=>JSON.parse(fs.readFileSync(path.join(packageRoot,'kernel/manifest.json')));
const preparations=new Map();
export async function prepare(root, manifest = shippedManifest(), options={}) {
  const pin=options.existingSha256??manifest.targets[target()]?.binary_sha256;
  const key=path.resolve(root)+':'+manifest.version+':'+target()+':'+pin;
  if(preparations.has(key))return preparations.get(key);
  const task=prepareOnce(root,manifest,options).finally(()=>preparations.delete(key));
  preparations.set(key,task);return task;
}
export async function download(urlString, fetcher=fetch) {
  let url=new URL(urlString);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Kernel downloads require HTTPS without credentials.');
  const allowed=new Set([url.hostname]);
  if(url.hostname==='github.com')for(const host of ['release-assets.githubusercontent.com','objects.githubusercontent.com'])allowed.add(host);
  for(let i=0;i<6;i++) {
    const response=await fetcher(url,{signal:AbortSignal.timeout(120_000),redirect:'manual'});
    if([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location)throw new Error('Invalid kernel download redirect.');
      url=new URL(location,url);
      if(url.protocol!=='https:'||!allowed.has(url.hostname)||url.username||url.password)throw new Error('Untrusted kernel download redirect.');
      continue;
    }
    if(!response.ok)throw new Error(`Kernel download failed (${response.status}); retry from jand settings.`);
    if(Number(response.headers.get('content-length'))>64*1024*1024)throw new Error('Kernel download too large.');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>64*1024*1024)throw new Error('Kernel download too large.');chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
  throw new Error('Too many kernel download redirects.');
}
export function cachedKernel(root,manifest=shippedManifest(),existingSha256) {
  const asset=manifest.targets[target()],hash=existingSha256??asset?.binary_sha256;
  if(!/^[a-f0-9]{64}$/.test(hash??''))return null;
  const file=path.join(root,'kernels',existingSha256?'local-'+hash:manifest.version,target(),hash,process.platform==='win32'?'jand.exe':'jand');
  if(!fs.existsSync(file))return null;
  if(sha256(fs.readFileSync(file))!==hash)throw new Error('Cached kernel checksum mismatch; refusing execution.');
  return file;
}
async function prepareOnce(root,manifest,{fetcher=fetch,existingPath,existingSha256}={}) {
  const key = target(), asset = manifest.targets[key];
  if (!asset) throw new Error(`No published native kernel for ${key}; this platform is not supported by the pinned release.`);
  if(existingSha256&&(!existingPath||!/^[a-f0-9]{64}$/.test(existingSha256)))throw new Error('A local kernel override requires an absolute path and explicit SHA-256.');
  const binaryHash=existingSha256??asset.binary_sha256;
  if(manifest.schema_version!==1||!/^\d+\.\d+\.\d+$/.test(manifest.version)||!/^[a-f0-9]{64}$/.test(binaryHash)||!/^[a-f0-9]{64}$/.test(asset.archive_sha256))throw new Error('Invalid pinned kernel manifest.');
  const destination = path.join(root, 'kernels', existingSha256?'local-'+binaryHash:manifest.version, key, binaryHash, process.platform === 'win32' ? 'jand.exe' : 'jand');
  if (fs.existsSync(destination)) {
    if (sha256(fs.readFileSync(destination)) !== binaryHash) throw new Error('Cached kernel checksum mismatch; refusing execution.');
    return destination;
  }
  let bytes;
  if (existingPath) {
    if(!path.isAbsolute(existingPath))throw new Error('Use an absolute existing kernel path.');
    bytes=fs.readFileSync(existingPath);
  } else {
    const archive=await download(asset.archive_url,fetcher);
    if(sha256(archive)!==asset.archive_sha256)throw new Error('Kernel archive checksum mismatch; refusing extraction.');
    bytes=extractBinary(archive,asset.binary_path,asset.archive_format??asset.format);
  }
  if (sha256(bytes) !== binaryHash) throw new Error('Kernel checksum mismatch; refusing execution.');
  fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
  const temp = `${destination}.${randomUUID()}`;
  fs.writeFileSync(temp, bytes, {mode: 0o700, flag: 'wx'});
  fs.renameSync(temp, destination);
  return destination;
}
export function runKernel(binary, args, {home, relay = 'https://jand.zhou-wei.com', tokenFile, signal, input, timeout = 1_850_000, json=true} = {}) {
  // Always force page opening off; inherit no global jand credentials/config.
  const env = {...process.env, JAND_HOME: home, JAND_RELAY: relay, JAND_PAGE: 'off'};
  delete env.JAND_ACCESS_TOKEN;
  if (tokenFile) env.JAND_ACCESS_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {env, signal, windowsHide: true, stdio: ['pipe','pipe','pipe'], timeout});
    let out = '', err = '', overflow = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (out.length + chunk.length > 16 * 1024 * 1024) {overflow = true; child.kill();} else out += chunk; });
    child.stderr.on('data', chunk => { if (err.length + chunk.length < 64 * 1024) err += chunk; });
    // stderr is deliberately never surfaced: it can contain capability URLs.
    child.on('error', () => reject(new Error(signal?.aborted ? 'Kernel canceled.' : 'Kernel could not start.')));
    child.on('close', (code, sig) => {
      if (overflow) return reject(new Error('Kernel output exceeded safe limit; cursor was not committed.'));
      if (sig) return reject(new Error(signal?.aborted ? 'Kernel canceled.' : 'Kernel terminated before completion.'));
      try {
        if(!json)return resolve({code,stdout:out});
        const events = out.trim() ? out.trim().split('\n').map(line => JSON.parse(line)) : [];
        resolve({code, events});
      } catch { reject(new Error('Invalid kernel JSON; cursor was not committed.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
