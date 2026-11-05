import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync,deflateRawSync} from 'node:zlib';
import {extractBinary} from '../src/archive.js';
import {prepare,sha256,target,download,kernelOrigin,kernelProgress} from '../src/kernel.js';
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
  await assert.rejects(prepare(root,manifest,options),/JAND_KERNEL_BINARY/);
});
test('download follows known GitHub asset redirects and rejects insecure or foreign redirects',async()=>{
  const data=await download('https://github.com/owner/repo/file',async url=>url.hostname==='github.com'?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/file'}}):new Response('asset'));
  assert.equal(data.toString(),'asset');
  await assert.rejects(download('http://example.org/file'),/HTTPS/);
  await assert.rejects(download('https://github.com/file',async()=>new Response(null,{status:302,headers:{location:'https://untrusted.example/file'}})),/JAND_KERNEL_REDIRECT/);
  await assert.rejects(download('https://github.com/file',async()=>new Response(null,{status:503})),/JAND_KERNEL_HTTP/);
});
test('kernel failures keep distinct actionable causes instead of one generic message',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-kernel-codes-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('fixture'),base={schema_version:1,version:'0.0.5',targets:{[target()]:{archive_url:'https://fixture.example/kernel',archive_sha256:sha256(bytes),binary_sha256:sha256(bytes),binary_path:'jand',archive_format:'raw'}}};
  const failure=async cause=>{try{await prepare(root,base,{fetcher:async()=>{throw cause;}});}catch(error){return error.code;}};
  assert.equal(await failure(Object.assign(new Error('fetch failed'),{cause:{code:'ENOTFOUND'}})),'JAND_KERNEL_OFFLINE');
  assert.equal(await failure(Object.assign(new Error('timed out'),{name:'TimeoutError'})),'JAND_KERNEL_TIMEOUT');
  assert.equal(await failure(Object.assign(new Error('fetch failed'),{cause:{code:'CERT_HAS_EXPIRED'}})),'JAND_KERNEL_TLS');
  assert.equal(await failure(new Error('socket hang up')),'JAND_KERNEL_NETWORK');
  await assert.rejects(prepare(root,{schema_version:1,version:'0.0.6',targets:{}}),/JAND_KERNEL_UNSUPPORTED/);
  const cached=await prepare(root,{...base,version:'0.0.7'},{fetcher:async()=>new Response(bytes)});
  fs.writeFileSync(cached,'tampered');
  await assert.rejects(prepare(root,{...base,version:'0.0.7'}),/JAND_KERNEL_CACHED/);
});
test('pinned backup serves the same verified kernel after primary timeout or HTTP failure',async t=>{
  const bytes=Buffer.from('backup fixture'),archive=tar('release/jand',bytes);
  const manifest={schema_version:1,version:'0.0.8',targets:{[target()]:{archive_url:'https://github.com/fixture/kernel',archive_mirrors:['https://mirror.example/kernel'],archive_sha256:sha256(archive),binary_sha256:sha256(bytes),binary_path:'release/jand',archive_format:'tar.gz'}}};
  for(const primary of [()=>new Response(null,{status:503}),()=>{throw Object.assign(new Error('timeout'),{name:'TimeoutError'});}]) {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-backup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const hosts=[];
    const binary=await prepare(root,manifest,{fetcher:async(url,options)=>{
      hosts.push(url.hostname);assert.ok(options.signal instanceof AbortSignal);assert.equal(options.redirect,'manual');
      return url.hostname==='github.com'?primary():new Response(archive);
    }});
    // Each source gets one immediate retry before the next pinned origin is used.
    assert.deepEqual(hosts,['github.com','github.com','mirror.example']);assert.deepEqual(fs.readFileSync(binary),bytes);
  }
});
test('failed sources preserve causes; unsafe redirects and corrupt archives never fall back or populate cache',async t=>{
  const bytes=Buffer.from('backup fixture'),archive=tar('release/jand',bytes);
  const manifest={schema_version:1,version:'0.0.9',targets:{[target()]:{archive_url:'https://github.com/fixture/kernel',archive_mirrors:['https://mirror.example/kernel'],archive_sha256:sha256(archive),binary_sha256:sha256(bytes),binary_path:'release/jand',archive_format:'tar.gz'}}};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-backup-failure-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await assert.rejects(prepare(root,manifest,{fetcher:async url=>{
    if(url.hostname==='github.com')throw Object.assign(new Error('offline'),{cause:{code:'ENOTFOUND'}});
    return new Response(null,{status:404});
  }}),error=>{
    assert.equal(error.code,'JAND_KERNEL_HTTP');
    assert.deepEqual(error.attempts,[{host:'github.com',code:'JAND_KERNEL_OFFLINE'},{host:'mirror.example',code:'JAND_KERNEL_HTTP'}]);return true;
  });
  for(const [response,code] of [[new Response('corrupt'),'JAND_KERNEL_ARCHIVE'],[new Response(null,{status:302,headers:{location:'https://foreign.example/file'}}),'JAND_KERNEL_REDIRECT']]) {
    let calls=0;
    await assert.rejects(prepare(root,manifest,{fetcher:async()=>{calls++;return response;}}),{code});assert.equal(calls,1);
  }
  assert.equal(fs.existsSync(path.join(root,'kernels')),false);
  manifest.targets[target()].archive_mirrors=['http://mirror.example/kernel'];
  await assert.rejects(prepare(root,manifest,{fetcher:()=>{throw Error('must validate before download');}}),{code:'JAND_KERNEL_INSECURE'});
});

test('a prepared kernel records which pinned source served it',async t=>{
  const bytes=Buffer.from('origin fixture'),archive=tar('release/jand',bytes);
  const manifest={schema_version:1,version:'0.0.10',targets:{[target()]:{archive_url:'https://github.com/fixture/kernel',archive_mirrors:['https://mirror.example/kernel'],archive_sha256:sha256(archive),binary_sha256:sha256(bytes),binary_path:'release/jand',archive_format:'tar.gz'}}};
  let attempt=0;
  const run=async primary=>{
    attempt+=1;
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-origin-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const binary=await prepare(root,{...manifest,version:'1.0.'+attempt},{fetcher:async url=>url.hostname==='github.com'?primary():new Response(archive)});
    return {binary,origin:kernelOrigin(binary)};
  };
  const primary=await run(()=>new Response(archive));
  assert.equal(primary.origin.source,'primary');assert.equal(primary.origin.host,'github.com');
  assert.ok(!Number.isNaN(Date.parse(primary.origin.at)),'origin must record when it was prepared');
  const backup=await run(()=>new Response(null,{status:503}));
  assert.equal(backup.origin.source,'backup');assert.equal(backup.origin.host,'mirror.example');
  assert.equal(fs.readFileSync(backup.binary).toString(),bytes.toString());
});
test('an unwritable origin sidecar never blocks a verified kernel',async t=>{
  const bytes=Buffer.from('sidecar failure'),archive=tar('release/jand',bytes);
  const manifest={schema_version:1,version:'0.0.11',targets:{[target()]:{archive_url:'https://github.com/fixture/kernel',archive_sha256:sha256(archive),binary_sha256:sha256(bytes),binary_path:'release/jand',archive_format:'tar.gz'}}};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sidecar-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binary=await prepare(root,manifest,{fetcher:async()=>new Response(archive)});
  assert.ok(fs.existsSync(binary));
  // Blocking the sidecar path must not cost the verified kernel itself.
  fs.rmSync(binary);fs.rmSync(binary+'.origin.json');fs.mkdirSync(binary+'.origin.json');
  const again=await prepare(root,manifest,{fetcher:async()=>new Response(archive)});
  assert.equal(fs.readFileSync(again).toString(),bytes.toString());
  assert.equal(kernelOrigin(again),null,'an unavailable sidecar reads as unknown, not as an error');
});

test('preparation reports progress and retries a transport failure once',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-progress-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('progress fixture'),archive=tar('release/jand',bytes);
  const manifest={schema_version:1,version:'3.0.0',targets:{[target()]:{archive_url:'https://github.com/fixture/kernel',archive_sha256:sha256(archive),binary_sha256:sha256(bytes),binary_path:'release/jand',archive_format:'tar.gz'}}};

  const seen=[];
  const stream=new ReadableStream({start(controller){controller.enqueue(archive.subarray(0,Math.floor(archive.length/2)));controller.enqueue(archive.subarray(Math.floor(archive.length/2)));controller.close();}});
  const reported=[];
  const streamed=await download('https://github.com/fixture/kernel',async()=>new Response(stream,{headers:{'content-length':String(archive.length)}}),5_000,value=>reported.push(value));
  assert.equal(sha256(streamed),sha256(archive));
  assert.ok(reported.length>=2,'progress must be reported while bytes arrive');
  assert.equal(reported.at(-1).received,archive.length);
  assert.equal(reported.at(-1).total,archive.length);
  assert.ok(reported.every((value,index)=>index===0||value.received>=reported[index-1].received),'progress never goes backwards');

  let calls=0;
  const binary=await prepare(root,manifest,{fetcher:async()=>{calls+=1;if(calls===1)throw Object.assign(new Error('reset'),{cause:{code:'ECONNRESET'}});return new Response(archive);}});
  assert.equal(calls,2,'one transport failure is retried on the same source');
  assert.deepEqual(fs.readFileSync(binary),bytes);
  assert.equal(kernelProgress(),null,'progress is cleared once preparation finished');
  void seen;
});
