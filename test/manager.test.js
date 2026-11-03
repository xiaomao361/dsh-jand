import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConversationManager } from '../src/manager.js';
import { layout, atomic, emptyState } from '../src/store.js';
import { receive } from '../src/receive.js';

const chat='b'.repeat(32);
function fixture(t,options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-jand-manager-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return new ConversationManager({root,jobs:{start(){throw Error('must not start');}},fetcher:async()=>new Response(JSON.stringify({status:'ok',access:true})),...options});
}
test('creation onboarding preserves token-required; private token import is relay-scoped',async t=>{
  const manager=fixture(t);
  assert.equal((await manager.open('/tmp/fixture.md','agreed fixture','owner')).outcome,'token_required');
  const source=path.join(manager.root,'operator-token');fs.writeFileSync(source,'fixture-not-a-real-secret\n');
  assert.deepEqual(manager.setupToken(source),{outcome:'configured',relay:manager.relay});
  assert.equal(fs.readFileSync(manager.creationTokenFile(),'utf8'),'fixture-not-a-real-secret');
  if(process.platform!=='win32')assert.equal(fs.statSync(manager.creationTokenFile()).mode&0o777,0o600);
  const another=new ConversationManager({root:manager.root,jobs:{},relay:'https://example.org'});
  assert.equal(another.creationTokenFile(),undefined);
});
test('five failed receives suspend; ended and pending inbox prevent new jobs',async t=>{
  const manager=fixture(t);const p=layout(manager.root,chat);
  const state=emptyState();state.failures=5;atomic(p.state,state);
  assert.equal((await manager.arm(chat,'owner')).outcome,'suspended');
  state.ended=true;atomic(p.state,state);assert.equal((await manager.arm(chat,'owner')).outcome,'ended');
  state.ended=false;state.records=[{id:'message:g1',event:{event:'message'}}];atomic(p.state,state);
  assert.equal((await manager.arm(chat,'owner')).outcome,'pending_inbox');
  assert.throws(()=>manager.read(chat,'other-owner'),/another DSH session/);
  assert.equal(manager.active.size,0);
});
test('retry time delays the next receive rather than completing another empty job',async t=>{
  const manager=fixture(t),p=layout(manager.root,chat),state=emptyState();
  state.retryAt=Date.now()+80;state.failures=1;atomic(p.state,state);
  atomic(path.join(manager.root,'home/chats',chat+'.json'),{id:chat});
  let ranAt;
  const result=await receive({root:manager.root,chat,execute:async()=>{ranAt=Date.now();return {code:0,events:[{event:'no_events'}]};}});
  assert.ok(ranAt>=state.retryAt);assert.equal(result.outcome,'no_events');
});
test('invitation parsing rejects option injection and relay credential confusion',async t=>{
  const manager=fixture(t,{relay:'https://jand.zhou-wei.com/'});
  await assert.rejects(manager.join('--help','owner'),/canonical/);
  await assert.rejects(manager.accept('https://other.example/r#'+'A'.repeat(43),'owner'),/configured relay/);
  assert.doesNotThrow(()=>manager.validateInvitation(manager.relay+'/r#'+'A'.repeat(43)));
});
test('reply without a peer reference fails before preparing or executing a kernel',async t=>{
 const manager=fixture(t,{kernel:async()=>{throw Error('kernel must not run');}});
 await assert.rejects(manager.send(chat,'owner',{kind:'reply',text:'not sent'}),error=>{assert.equal(error.code,'JAND_INVALID_ARGUMENT');assert.equal(error.sent,false);assert.match(error.message,/reply_to/);return true;});
});
test('kernel command failure categories stay distinct without exposing raw diagnostics',async t=>{
 const manager=fixture(t,{kernel:async()=>process.execPath});
 for(const [code,name] of [[1,'JAND_COMMAND_FAILED'],[2,'JAND_INVALID_COMMAND'],[3,'JAND_COMMAND_UNCONFIRMED'],[4,'JAND_CHAT_ENDED_OR_GONE'],[0,'JAND_COMMAND_FAILED']]){
  await assert.rejects(manager.command(chat,'owner',['-e',`process.stdout.write(JSON.stringify({event:'error',message:'sensitive-fixture-never-surface'}));process.stderr.write('private-stderr-fixture');process.exit(${code});`]),error=>{assert.equal(error.code,name);assert.equal(error.exitCode,code);assert.ok(!error.message.includes('sensitive-fixture'));assert.ok(!error.message.includes('private-stderr'));if(code===3)assert.match(error.message,/Do not assume/);return true;});
 }
});

test('inspect reports receiver lifecycle independently from an open conversation',async t=>{
 const manager=fixture(t),directory=path.join(manager.root,'home/chats');
 atomic(path.join(directory,chat+'.json'),{id:chat,role:'host'});
 fs.writeFileSync(path.join(directory,chat+'.transcript.jsonl'),[{time:'2026-11-02T08:00:00Z',kind:'started',text:'goal'},{time:'2026-11-02T08:01:00Z',kind:'joined',from:'guest'}].map(JSON.stringify).join('\n')+'\n');
 for(const [entry,expected] of [[undefined,'stopped'],[{owner:'owner'},'starting'],[{owner:'owner',id:'job-fixture'},'running'],[{owner:'owner',id:'job-fixture',canceled:true},'stopping']]){
  if(entry)manager.active.set(chat,entry);else manager.active.delete(chat);
  const value=await manager.inspect(chat);assert.equal(value.status,'active');assert.equal(value.reception.listener,expected);
 }
 manager.active.clear();
});
