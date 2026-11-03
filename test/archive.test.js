import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync,deflateRawSync} from 'node:zlib';
import {extractBinary} from '../src/archive.js';
import {prepare,sha256,target,download} from '../src/kernel.js';
function tar(name,bytes) {
  const header=Buffer.alloc(512);header.write(name);header.write('0000700\0',100);header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header.fill(32,148,156);header[156]=48;
  const sum=header.reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  return gzipSync(Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512+1024)]));
}
function zip(name,bytes) {
  const n=Buffer.from(name),compressed=deflateRawSync(bytes),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(8,8);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(n.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(n.length,28);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+n.length,12);end.writeUInt32LE(local.length+n.length+compressed.length,16);
  return Buffer.concat([local,n,compressed,central,n,end]);
}
for(const [format,build]of [['tar.gz',tar],['zip',zip]])test(`${format}: extract exact bounded member; verify archive and executable independently`,async t=>{
  const member='release/jand',bytes=Buffer.from('fixture kernel, never executed'),archive=build(member,bytes);
  assert.deepEqual(extractBinary(archive,member,format),bytes);
  assert.throws(()=>extractBinary(archive,'../jand',format),/Invalid/);
  assert.throws(()=>extractBinary(archive,'missing',format),/missing/);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-archive-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manifest={schema_version:1,version:'0.0.2',targets:{[target()]:{archive_url:'https://fixture.example/kernel',archive_sha256:sha256(archive),binary_sha256:sha256(bytes),binary_path:member,archive_format:format}}};
  let downloads=0;
  const options={fetcher:async()=>{downloads++;return new Response(archive);}};
  const [a,b]=await Promise.all([prepare(root,manifest,options),prepare(root,manifest,options)]);
  assert.equal(a,b);assert.equal(downloads,1);assert.deepEqual(fs.readFileSync(a),bytes);
  await prepare(root,manifest,{fetcher:()=>{throw Error('cache must avoid download');}});
  manifest.version='0.0.3';manifest.targets[target()].archive_sha256='0'.repeat(64);
  await assert.rejects(prepare(root,manifest,options),/archive checksum/);
  assert.ok(!fs.existsSync(path.join(root,'kernels','0.0.3')));
  manifest.version='0.0.4';manifest.targets[target()].archive_sha256=sha256(archive);manifest.targets[target()].binary_sha256='0'.repeat(64);
  await assert.rejects(prepare(root,manifest,options),/Kernel checksum/);
});
test('download follows known GitHub asset redirects and rejects insecure or foreign redirects',async()=>{
  const data=await download('https://github.com/owner/repo/file',async url=>url.hostname==='github.com'?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/file'}}):new Response('asset'));
  assert.equal(data.toString(),'asset');
  await assert.rejects(download('http://example.org/file'),/HTTPS/);
  await assert.rejects(download('https://github.com/file',async()=>new Response(null,{status:302,headers:{location:'https://untrusted.example/file'}})),/Untrusted/);
  await assert.rejects(download('https://github.com/file',async()=>new Response(null,{status:503})),/503/);
});
