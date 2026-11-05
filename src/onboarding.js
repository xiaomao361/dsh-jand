import fs from 'node:fs';
import path from 'node:path';
import { atomic, read } from './store.js';
import { shippedManifest, target, sha256, kernelOrigin, kernelProgress } from './kernel.js';

export function relayOrigin(value) {
  let url;try{url=new URL(value);}catch{throw new Error('Enter a valid relay address.');}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['https:','http:'].includes(url.protocol))throw new Error('Use a relay origin without credentials or a path.');
  if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Remote relays require HTTPS.');
  return url.origin;
}
export function kernelStatus(root,manifest=shippedManifest(),localSha256) {
  const platform=target(),asset=manifest.targets[platform],published=Object.keys(manifest.targets);
  if(!asset)return {state:'unsupported',platform,version:manifest.version,supported:false,published};
  const file=path.join(root,'kernels',localSha256?'local-'+localSha256:manifest.version,platform,localSha256??asset.binary_sha256,process.platform==='win32'?'jand.exe':'jand');
  const shape={state:'not_downloaded',platform,version:localSha256?'local-dev':manifest.version,supported:true,signed:!!asset.platform_signed,notarized:!!asset.notarized,source:new URL(asset.archive_url).hostname,sources:[asset.archive_url,...(asset.archive_mirrors??[])].map(value=>new URL(value).hostname)};
  if(!fs.existsSync(file))return shape;
  const state=sha256(fs.readFileSync(file))===(localSha256??asset.binary_sha256)?'ready':'checksum_mismatch';
  // Which pinned origin actually produced this copy, when it is known.
  return {...shape,state,...state==='ready'?{origin:kernelOrigin(file)}:null};
}
export async function probeRelay(relay,fetcher=fetch) {
  try {
    const response=await fetcher(relayOrigin(relay)+'/healthz',{redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok)return {state:'unavailable',access:null};
    const text=await response.text();if(text.length>16_384)return {state:'invalid',access:null};
    const value=JSON.parse(text);
    if(value.status!=='ok'||typeof value.access!=='boolean')return {state:'invalid',access:null};
    return {state:'online',access:value.access,...typeof value.version==='string'?{version:value.version}:{}};
  } catch {return {state:'unavailable',access:null};}
}
export function creationState(probe,configured) {
  if(probe.state!=='online')return 'relay_unavailable';
  if(!probe.access)return 'anonymous_allowed';
  return configured?'token_configured':'token_required';
}
export async function status(manager,{probe=true,fetcher=manager.fetcher??fetch}={}) {
  const health=probe?await probeRelay(manager.relay,fetcher):{state:'unchecked',access:null};
  return {relay:manager.relay,health,kernel:kernelStatus(manager.root,undefined,manager.localKernelSha256),tokenConfigured:!!manager.creationTokenFile(),creation:creationState(health,!!manager.creationTokenFile()),join:'invitation_only',preparation:kernelProgress(),harness:manager.harness??null,
    guide:{canReceiveWithoutCreationToken:true,tokenIsOperatorIssued:true,tokenValidated:false}};
}
export function configure(manager,request) {
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['relay','token_file'].includes(k)))throw new Error('Invalid jand settings.');
  if(manager.active.size)throw new Error('Stop active jand listeners before changing settings.');
  const next=request.relay===undefined?manager.relay:relayOrigin(request.relay);
  const prior=manager.relay;manager.relay=next;
  try {
    if(request.token_file!==undefined)manager.setupToken(request.token_file);
    atomic(path.join(manager.root,'preferences.json'),{schema_version:1,relay:next});
    return {outcome:'configured',relay:next,tokenConfigured:!!manager.creationTokenFile()};
  } catch(error){manager.relay=prior;throw error;}
}
export const savedRelay=(root,fallback)=>relayOrigin(read(path.join(root,'preferences.json'),{relay:fallback}).relay);
