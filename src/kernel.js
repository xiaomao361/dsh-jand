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
// Every kernel failure carries a stable JAND_KERNEL_* code so the assistant can
// name the real cause and the settings page can show one actionable sentence.
export function kernelError(code, message, cause) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}
function transportFailure(error) {
  const detail = String(error?.cause?.code ?? error?.code ?? '');
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /TIMEOUT/.test(detail)) {
    return kernelError('JAND_KERNEL_TIMEOUT', 'the kernel download exceeded its source time limit. Check the network and retry from jand settings.', error);
  }
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|EPROTO/i.test(detail)) {
    return kernelError('JAND_KERNEL_TLS', 'the kernel download failed TLS verification. Check the system clock and any network proxy, then retry from jand settings.', error);
  }
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|EPIPE)$/.test(detail)) {
    return kernelError('JAND_KERNEL_OFFLINE', 'the kernel download host is unreachable. Check access to GitHub and the configured backup origin, then retry from jand settings.', error);
  }
  return kernelError('JAND_KERNEL_NETWORK', 'the kernel download failed before any file was verified. Check the network, then retry from jand settings.', error);
}
const transportRetryable=new Set(['JAND_KERNEL_TIMEOUT','JAND_KERNEL_OFFLINE','JAND_KERNEL_NETWORK','JAND_KERNEL_HTTP','JAND_KERNEL_TLS']);
let activeProgress=null;
// Single in-flight preparation snapshot for the settings page; cleared when done.
export const kernelProgress=()=>activeProgress?{...activeProgress}:null;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const preparations=new Map();
export async function prepare(root, manifest = shippedManifest(), options={}) {
  const pin=options.existingSha256??manifest.targets[target()]?.binary_sha256;
  const key=path.resolve(root)+':'+manifest.version+':'+target()+':'+pin;
  if(preparations.has(key))return preparations.get(key);
  const task=prepareOnce(root,manifest,options).finally(()=>preparations.delete(key));
  preparations.set(key,task);return task;
}
export async function download(urlString, fetcher=fetch, timeoutMs=120_000, onProgress) {
  let url=new URL(urlString);
  if(url.protocol!=='https:'||url.username||url.password)throw kernelError('JAND_KERNEL_INSECURE','kernel downloads require HTTPS without credentials.');
  const allowed=new Set([url.hostname]);
  if(url.hostname==='github.com')for(const host of ['release-assets.githubusercontent.com','objects.githubusercontent.com'])allowed.add(host);
  const signal=AbortSignal.timeout(timeoutMs);
  for(let i=0;i<6;i++) {
    let response;
    try { response=await fetcher(url,{signal,redirect:'manual'}); }
    catch(error){ throw transportFailure(error); }
    if([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location)throw kernelError('JAND_KERNEL_REDIRECT','the kernel download returned a redirect without a target. Retry from jand settings.');
      url=new URL(location,url);
      if(url.protocol!=='https:'||!allowed.has(url.hostname)||url.username||url.password)throw kernelError('JAND_KERNEL_REDIRECT','the kernel download was redirected to an unapproved host and was refused. A network proxy may be interfering.');
      continue;
    }
    if(!response.ok)throw kernelError('JAND_KERNEL_HTTP',`the kernel download returned HTTP ${response.status}. Retry from jand settings; a permanent failure means this pinned release asset is no longer available.`);
    const declared=Number(response.headers.get('content-length'));
    if(declared>64*1024*1024)throw kernelError('JAND_KERNEL_SIZE','the kernel download exceeded the 64 MB limit and was refused.');
    const chunks=[];let size=0,reported=0;
    onProgress?.({received:0,total:Number.isFinite(declared)&&declared>0?declared:null});
    try {
      for await(const chunk of response.body){
        size+=chunk.length;
        if(size>64*1024*1024)throw kernelError('JAND_KERNEL_SIZE','the kernel download exceeded the 64 MB limit and was refused.');
        chunks.push(chunk);
        if(size-reported>=256*1024){reported=size;onProgress?.({received:size,total:Number.isFinite(declared)&&declared>0?declared:null});}
      }
    } catch(error){ if(error?.code?.startsWith?.('JAND_KERNEL_'))throw error; throw transportFailure(error); }
    onProgress?.({received:size,total:Number.isFinite(declared)&&declared>0?declared:size});
    return Buffer.concat(chunks);
  }
  throw kernelError('JAND_KERNEL_REDIRECT','the kernel download exceeded the redirect limit and was refused. A network proxy may be redirecting it repeatedly.');
}
function writeKernel(destination, bytes) {
  try {
    fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
    const temp = `${destination}.${randomUUID()}`;
    fs.writeFileSync(temp, bytes, {mode: 0o700, flag: 'wx'});
    fs.renameSync(temp, destination);
  } catch(error){ throw kernelError('JAND_KERNEL_WRITE','the kernel could not be written to the local cache. Check free disk space and folder permissions, then retry.',error); }
}
function writeOrigin(destination, origin) {
  // Best effort only: an unwritable sidecar must never block a verified kernel.
  try { fs.writeFileSync(destination+'.origin.json', JSON.stringify(origin)+'\n', {mode:0o600}); } catch {}
}
export async function installLocal(root, manifest=shippedManifest(), file) {
  const key=target(), asset=manifest.targets[key];
  if(!asset) throw kernelError('JAND_KERNEL_UNSUPPORTED',`no published native kernel for ${key}; this platform is not supported by the pinned release.`);
  if(typeof file!=='string'||!path.isAbsolute(file)) throw kernelError('JAND_KERNEL_IMPORT','importing requires an absolute path to the official archive or runtime file.');
  if(manifest.schema_version!==1||!/^[a-f0-9]{64}$/.test(asset.binary_sha256??'')||!/^[a-f0-9]{64}$/.test(asset.archive_sha256??''))throw kernelError('JAND_KERNEL_MANIFEST','the pinned kernel manifest is invalid; refusing to import.');
  let bytes;
  try {
    const info=fs.statSync(file);
    if(!info.isFile())throw new Error('not a regular file');
    if(info.size>64*1024*1024)throw kernelError('JAND_KERNEL_SIZE','the imported file exceeded the 64 MB limit and was refused.');
    bytes=fs.readFileSync(file);
  } catch(error) {
    if(error?.code?.startsWith?.('JAND_KERNEL_'))throw error;
    throw kernelError('JAND_KERNEL_IMPORT','the local file could not be read. Check the absolute path and its permissions.',error);
  }
  let binary=null;
  if(sha256(bytes)===asset.archive_sha256) {
    try { binary=extractBinary(bytes,asset.binary_path,asset.archive_format??asset.format); }
    catch(error){ throw kernelError('JAND_KERNEL_ARCHIVE','the imported archive could not be read safely; refusing extraction.',error); }
  } else if(sha256(bytes)===asset.binary_sha256) binary=bytes;
  else throw kernelError('JAND_KERNEL_IMPORT',`the imported file matches neither the official ${manifest.version} archive nor its runtime for ${key}. Import the unmodified official file instead.`);
  if(sha256(binary)!==asset.binary_sha256) throw kernelError('JAND_KERNEL_BINARY','the imported runtime checksum mismatch; refusing to install.');
  const destination=path.join(root,'kernels',manifest.version,key,asset.binary_sha256,process.platform==='win32'?'jand.exe':'jand');
  if(fs.existsSync(destination)&&sha256(fs.readFileSync(destination))===asset.binary_sha256) return destination;
  activeProgress={stage:'write',source:'local',received:binary.length,total:binary.length,platform:key,startedAt:new Date().toISOString(),attempt:1};
  try{writeKernel(destination, binary);}finally{activeProgress=null;}
  writeOrigin(destination, {source:'import',host:'local',at:new Date().toISOString()});
  return destination;
}
export function kernelOrigin(binaryPath) {
  try { return JSON.parse(fs.readFileSync(binaryPath+'.origin.json','utf8')); }
  catch { return null; }
}
export function cachedKernel(root,manifest=shippedManifest(),existingSha256) {
  const asset=manifest.targets[target()],hash=existingSha256??asset?.binary_sha256;
  if(!/^[a-f0-9]{64}$/.test(hash??''))return null;
  const file=path.join(root,'kernels',existingSha256?'local-'+hash:manifest.version,target(),hash,process.platform==='win32'?'jand.exe':'jand');
  if(!fs.existsSync(file))return null;
  if(sha256(fs.readFileSync(file))!==hash)throw kernelError('JAND_KERNEL_CACHED','cached kernel checksum mismatch; refusing execution. Remove the cached kernel and prepare it again.');
  return file;
}
async function prepareOnce(root,manifest,{fetcher=fetch,existingPath,existingSha256}={}) {
  const key = target(), asset = manifest.targets[key];
  if (!asset) throw kernelError('JAND_KERNEL_UNSUPPORTED',`no published native kernel for ${key}; this platform is not supported by the pinned release. On Windows ARM64, use the x64 DeepSeek Harness build, which Windows runs by emulation, or wait for an official ARM64 asset.`);
  if(existingSha256&&(!existingPath||!/^[a-f0-9]{64}$/.test(existingSha256)))throw kernelError('JAND_KERNEL_OVERRIDE','a local kernel override requires an absolute path and explicit SHA-256.');
  const binaryHash=existingSha256??asset.binary_sha256;
  if(manifest.schema_version!==1||!/^\d+\.\d+\.\d+$/.test(manifest.version)||!/^[a-f0-9]{64}$/.test(binaryHash)||!/^[a-f0-9]{64}$/.test(asset.archive_sha256))throw kernelError('JAND_KERNEL_MANIFEST','the pinned kernel manifest is invalid; refusing to download.');
  const destination = path.join(root, 'kernels', existingSha256?'local-'+binaryHash:manifest.version, key, binaryHash, process.platform === 'win32' ? 'jand.exe' : 'jand');
  if (fs.existsSync(destination)) {
    if (sha256(fs.readFileSync(destination)) !== binaryHash) throw kernelError('JAND_KERNEL_CACHED','cached kernel checksum mismatch; refusing execution. Remove the cached kernel and prepare it again.');
    return destination;
  }
  let bytes,usedSource=null;
  if (existingPath) {
    if(!path.isAbsolute(existingPath))throw kernelError('JAND_KERNEL_OVERRIDE','use an absolute existing kernel path.');
    try { bytes=fs.readFileSync(existingPath); }
    catch(error){ throw kernelError('JAND_KERNEL_OVERRIDE','the local kernel file could not be read. Check the path and permissions.',error); }
  } else {
    const mirrors=asset.archive_mirrors??[];
    if(!Array.isArray(mirrors)||mirrors.length>3)throw kernelError('JAND_KERNEL_MANIFEST','invalid backup download list.');
    const sources=[asset.archive_url,...mirrors];
    for(const source of sources) {
      let url;try{url=new URL(source);}catch{throw kernelError('JAND_KERNEL_MANIFEST','invalid pinned download URL.');}
      if(url.protocol!=='https:'||url.username||url.password)throw kernelError('JAND_KERNEL_INSECURE','kernel downloads require HTTPS without credentials.');
    }
    const startedAt=new Date().toISOString();
    try {
      let archive=null;
      const failures=[];
      for(const [index,source] of sources.entries()) {
        const host=new URL(source).hostname;
        // One immediate retry per source: a transient reset should not cost the
        // whole preparation, and the next pinned origin is still tried after it.
        for(let attempt=1;attempt<=2;attempt++) {
          activeProgress={stage:'download',source:host,received:0,total:null,platform:key,startedAt,attempt};
          try {
            archive=await download(source,fetcher,index<sources.length-1?15_000:120_000,progress=>{
              if(activeProgress)activeProgress={...activeProgress,received:progress.received,total:progress.total};
            });
            usedSource=source;
            break;
          } catch(error) {
            const retryable=transportRetryable.has(error.code);
            if(retryable&&attempt===1){await delay(1_000);continue;}
            failures.push({host,code:error.code});
            // Security, size and integrity failures must remain visible; only
            // transport/HTTP availability failures may use another pinned origin.
            if(!retryable)throw error;
            if(index===sources.length-1) {
              const failure=kernelError(error.code,`all pinned kernel download sources failed (${failures.map(item=>item.host+': '+item.code).join('; ')}). Check the network and retry from jand settings.`,error);
              failure.attempts=failures;throw failure;
            }
            break;
          }
        }
        if(archive)break;
      }
      if(!archive)throw kernelError('JAND_KERNEL_NETWORK','every pinned kernel download source returned no data. Check the network and retry from jand settings.');
      activeProgress={...activeProgress,stage:'verify'};
      if(sha256(archive)!==asset.archive_sha256)throw kernelError('JAND_KERNEL_ARCHIVE','kernel archive checksum mismatch; refusing extraction. The download was truncated or altered, so retry it.');
      activeProgress={...activeProgress,stage:'extract'};
      try { bytes=extractBinary(archive,asset.binary_path,asset.archive_format??asset.format); }
      catch(error){ throw kernelError('JAND_KERNEL_ARCHIVE','the downloaded kernel archive could not be read safely; refusing extraction. Retry the download.',error); }
    } finally { activeProgress=null; }
  }
  if (sha256(bytes) !== binaryHash) throw kernelError('JAND_KERNEL_BINARY','kernel checksum mismatch; refusing execution. Retry the download.');
  writeKernel(destination, bytes);
  if (usedSource) writeOrigin(destination, {source:usedSource===asset.archive_url?'primary':'backup',host:new URL(usedSource).hostname,at:new Date().toISOString()});
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
