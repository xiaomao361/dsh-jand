import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { receive } from '../src/receive.js';
import { atomic, read, layout, recover, inbox, acknowledge, lock } from '../src/store.js';
import { prepare, sha256, target, packageRoot } from '../src/kernel.js';

const chat = 'a'.repeat(32);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'dsh-jand-test-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'home/chats'),{recursive:true});
  atomic(path.join(root,'home/chats',`${chat}.json`),{id:chat});
  atomic(path.join(root,'home/chats',`${chat}.cursor`),{after:0});
  return root;
}
const message = {event:'message',id:'g1',kind:'request',text:'untrusted fixture'};
function executable(events=[message],code=0) {
  return async (_binary,_args,{home}) => {
    atomic(path.join(home,'chats',`${chat}.cursor`),{after:1});
    return {code,events};
  };
}
test('durable event precedes cursor commit; explicit ack deduplicates replay', async t => {
  const root = fixture(t);
  const result = await receive({root,chat,execute:executable()});
  assert.equal(result.outcome,'received');
  assert.equal(read(path.join(root,'home/chats',`${chat}.cursor`)).after,1);
  assert.equal(inbox(root,chat).records[0].event.text,message.text);
  acknowledge(root,chat,['message:g1']);
  await receive({root,chat,execute:executable()});
  assert.equal(inbox(root,chat).records.length,0);
});
for (const point of ['inbox_committed','ready_committed']) test(`crash at ${point} remains recoverable without stdout`, async t => {
  const root=fixture(t);
  await assert.rejects(receive({root,chat,execute:executable(),fault:p=>{if(p===point)throw new Error('injected crash');}}));
  assert.equal(inbox(root,chat).records[0].event.id,'g1');
  if(point==='inbox_committed') await receive({root,chat,execute:executable()});
  assert.equal(inbox(root,chat).records.length,1);
  assert.equal(read(path.join(root,'home/chats',`${chat}.cursor`)).after,1);
});
test('no_events, malformed success, failure, cancel and ended stay distinct', async t => {
  const root=fixture(t);
  assert.equal((await receive({root,chat,execute:executable([{event:'no_events'}])})).outcome,'no_events');
  assert.equal((await receive({root,chat,execute:executable([])})).outcome,'failed');
  const before=read(path.join(root,'home/chats',`${chat}.cursor`)).after;
  const p=layout(root,chat); const s=read(p.state); s.retryAt=0;atomic(p.state,s);
  assert.equal((await receive({root,chat,execute:executable([message],1)})).outcome,'failed');
  assert.equal(read(path.join(root,'home/chats',`${chat}.cursor`)).after,before);
  const controller=new AbortController();controller.abort();
  assert.equal((await receive({root,chat,signal:controller.signal,execute:async()=>{throw Error();}})).outcome,'canceled');
  const reset=read(p.state);reset.retryAt=0;atomic(p.state,reset);
  assert.equal((await receive({root,chat,execute:executable([{event:'closed'}])})).outcome,'ended');
  assert.equal((await receive({root,chat,execute:()=>{throw Error('must not run');}})).outcome,'ended');
});
test('second receiver and ack cannot mutate state under an active receiver', async t => {
  const root=fixture(t);const release=lock(layout(root,chat).lock);
  assert.throws(()=>lock(layout(root,chat).lock),/already owns/);
  assert.throws(()=>acknowledge(root,chat,[]),/already owns/);
  release();
  const retry=lock(layout(root,chat).lock);retry();
});
test('CLI exit 4 with error event remains ended-or-gone and never retries as a network failure',async t=>{
  const root=fixture(t);
  const result=await receive({root,chat,execute:executable([{event:'error',message:'chat ended'}],4)});
  assert.equal(result.outcome,'ended_or_gone');
  assert.equal(inbox(root,chat).ended,true);
  assert.equal(inbox(root,chat).failures,0);
  assert.equal(inbox(root,chat).records[0].event.event,'error','retain original diagnostic');
});
test('pinned platform kernel prepares automatically and rejects cache tampering', async t => {
  const root=fixture(t),bytes=Buffer.from('synthetic-kernel-not-executed');
  const manifest={schema_version:1,version:'0.0.1',targets:{[target()]:{archive_url:'https://fixture.example/kernel',archive_sha256:sha256(bytes),binary_sha256:sha256(bytes),binary_path:'jand',archive_format:'raw'}}};
  const binary=await prepare(root,manifest,{fetcher:async()=>new Response(bytes)});
  assert.ok(fs.statSync(binary).isFile());
  const shipped=read(path.join(packageRoot,'kernel/manifest.json'));
  assert.equal(Object.keys(shipped.targets).length,5);
  assert.ok(Object.values(shipped.targets).every(a=>a.archive_url.startsWith('https:')&&a.binary_sha256.length===64&&!a.file));
  fs.writeFileSync(binary,'tampered');
  await assert.rejects(prepare(root,manifest),/checksum mismatch/);
  assert.throws(()=>target('darwin','mips'),/Unsupported/);
});
test('ack counts newly acknowledged unique ids and rejects mixed invalid batches without mutation',async t=>{
 const root=fixture(t);await receive({root,chat,execute:executable([message,{...message,id:'g2'}])});
 assert.deepEqual(acknowledge(root,chat,['message:g1','message:g1']),{acknowledged:1,already:0});
 const file=layout(root,chat).state,before=fs.readFileSync(file);
 assert.deepEqual(acknowledge(root,chat,['message:g1']),{acknowledged:0,already:1});assert.deepEqual(fs.readFileSync(file),before);
 assert.throws(()=>acknowledge(root,chat,['message:g2','message:unknown']),/Unknown inbox/);assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(inbox(root,chat).records.map(r=>r.id),['message:g2']);
 assert.deepEqual(acknowledge(root,chat,['message:g1','message:g2','message:g2']),{acknowledged:1,already:1});assert.deepEqual(inbox(root,chat).records,[]);
 assert.deepEqual(acknowledge(root,chat,[]),{acknowledged:0,already:0});
});
