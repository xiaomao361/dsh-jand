import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runtime, FixtureAdapter, disposeRuntime } from './runtime.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { prepare, runKernel,packageRoot } from '../src/kernel.js';
import { ConversationManager } from '../src/manager.js';
import { receive } from '../src/receive.js';
import * as plugin from '../index.js';
import { read, atomic, layout } from '../src/store.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {inspectLocal} from '../src/view.js';

const until = async predicate => {
  const deadline=Date.now()+15_000;
  while(!predicate()) { if(Date.now()>deadline)throw Error('Timed out waiting for native runtime evidence.');await delay(20); }
};
async function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-jand-native-'));
  const cleanup={relay:null,close:null};
  t.after(async()=>{
    try{await cleanup.close?.();}
    catch{cleanup.relay?.kill();throw new Error(`Fixture close failed; private recovery state retained at ${root}`);}
    cleanup.relay?.kill();fs.rmSync(root,{recursive:true,force:true});
  });
  const binary=await prepare(path.join(packageRoot,'.local/test-kernel'));
  let relay=process.env.DSH_JAND_TEST_RELAY;
  if(!relay) {
    const proc=spawn(binary,['relay','--listen','127.0.0.1:0'],{stdio:['ignore','pipe','pipe']});
    cleanup.relay=proc;
    relay=await new Promise((resolve,reject)=>{
      const scan=chunk=>{const match=chunk.toString().match(/addr=(\S+)/);if(match)resolve('http://'+match[1]);};
      proc.stderr.on('data',scan);proc.stdout.on('data',scan);proc.on('error',reject);
    });
  }
  const home=path.join(root,'host'),guestRoot=path.join(root,'guest'),guest=path.join(guestRoot,'home'),file=path.join(root,'packet.md');fs.writeFileSync(file,'# Test\nExchange fixed fixture messages only.');
  const manager=new ConversationManager({root:home,jobs:null,relay,wait:'30s',kernel:async()=>binary,tokenFile:process.env.DSH_JAND_TEST_TOKEN_FILE});
  let result;
  if(manager.tokenFile) result=await manager.open(file,'Native DSH fixture: reply with a fixed test string only','native-owner');
  else {
    const sent=await runKernel(binary,['send','--json','--chat','--goal','Native DSH fixture','--relay',relay,file],{home:path.join(home,'home'),relay});
    assert.equal(sent.code,0);result=sent.events;
  }
  const queued=result.find(e=>e.chat);assert.ok(queued);
  const chat=queued.chat;
  cleanup.close=async()=>{const r=await runKernel(binary,['chat','close','--json',chat],{home:path.join(home,'home'),relay,timeout:30_000});assert.ok([0,4].includes(r.code),`close fixture exit ${r.code}`);};
  const invoke=async (...args)=>{
    const r=await runKernel(binary,args,{home:guest,relay,timeout:30_000});assert.equal(r.code,0,`peer command exit ${r.code}`);return r.events;
  };
  const guestManager=new ConversationManager({root:guestRoot,jobs:null,relay,kernel:async()=>binary});
  const received=await guestManager.accept(queued.link,'guest-owner');
  assert.ok(received.some(e=>e.chat_invite===true),'invitation inspection does not join');
  await guestManager.join(queued.code,'guest-owner');
  await receive({root:home,chat,binary,relay,wait:'0s'});
  const pending=manager.read(chat,'native-owner');manager.ack(chat,pending.records.map(r=>r.id),'native-owner');
  return {root,home,binary,relay,chat,invoke};
}

test('real idle DSH owner wakes, reads through a tool, replies, acknowledges and rearms', {timeout:45_000}, async t => {
  const f=await setup(t);const {chat,home,relay}=f;
  let step=0;
  const calls=[
    ['jand_arm',{chat}],
    'Listening.',
    ['jand_inbox',{chat}],
    ['jand_send',{chat,kind:'reply',reply_to:'g1',text:'fixture-ack-g1'}],
    ['jand_ack',{chat,ids:['message:g1']}],
    ['jand_arm',{chat}],
    'Rearmed.'
  ];
  const ctx=await runtime(new FixtureAdapter(async ()=>{
    const action=calls[step++];
    if(!action) return 'No further authorized fixture actions.';
    return typeof action==='string'?action:{id:`call-${step}`,name:action[0],input:action[1]};
  }));
  const pluginFiber=ctx.plugin(plugin,{dataDir:home,relay,wait:'30s',kernelPath:f.binary});await pluginFiber;
  t.after(async()=>{await pluginFiber.dispose();await disposeRuntime(ctx);});
  const handle=await ctx.agents.create({sessionId:'native-owner',agentOptions:{provider:'fixture',model:'fixture'}});
  t.after(()=>handle.dispose());
  const agent=handle.agent;
  agent.followup(createUserMessage({content:[{type:'text',text:'Run the pre-authorized fixed jand fixture and listen.'}],source:{kind:'user'}}));
  await agent.whenIdle();
  assert.equal(agent.status,'idle');assert.equal(step,2);
  const initialJobs=ctx.jobs.list(agent.id);assert.equal(initialJobs.filter(j=>j.status==='running').length,1);
  // Try a duplicate arm through the actual registered tool.
  const duplicate=await ctx.tools.get('jand_arm',agent).execute({chat},{agent});
  assert.equal(duplicate.outcome,'already_armed');
  await f.invoke('chat','send','--json','--kind','request',chat,'fixture-request-g1');
  await until(()=>step>=7);
  await agent.whenIdle();
  const log=agent.session.snapshotEvents();
  const results=log.filter(e=>e.type==='tool/result');
  assert.equal(results.length,5);
  assert.ok(log.some(e=>e.type==='agent/inbox/spliced' && JSON.stringify(e.data).includes('tool-jobs')),'native notice reached durable owner inbox');
  assert.ok(JSON.stringify(results).includes('fixture-request-g1'),'formal inbox read reached session tool result');
  const reply=await f.invoke('chat','recv','--json','--wait','5s',chat);
  assert.ok(reply.some(e=>e.text==='fixture-ack-g1'&&e.reply_to==='g1'));
  assert.equal(ctx.jobs.list(agent.id).filter(j=>j.status==='running').length,1,'one rearmed receiver');
  const measured=inspectLocal(home,chat).statistics.plugin;
  assert.equal(measured.wakesAdmitted,1,'count the admitted idle wake, not just job settlement');
  assert.ok(measured.toolResultBytes>0,'measure committed tool-result content separately from CLI stdout');
  const stop=await ctx.tools.get('jand_stop',agent).execute({chat},{agent});assert.equal(stop.outcome,'stopped');
  assert.equal(ctx.jobs.list(agent.id).filter(j=>j.status==='running').length,0);
  console.log('Verified: idle owner → native notice → formal inbox tool → peer received reply → one rearmed job → clean stop. Model: deterministic fixture; UI not used.');
});

test('busy owner receives next-step notice; messages queued before rearm survive; closed stops', {timeout:45_000, skip:!!process.env.DSH_JAND_TEST_RELAY}, async t => {
  const f=await setup(t); const {chat,home,relay}=f;
  let step=0,releaseBusy;
  const busy=new Promise(resolve=>{releaseBusy=resolve;});
  const calls=[['jand_arm',{chat}], 'busy', ['jand_inbox',{chat}], ['jand_ack',{chat,ids:['message:g1']}], ['jand_arm',{chat}], 'rearmed', ['jand_inbox',{chat}], ['jand_ack',{chat,ids:['message:g2']}], 'finished'];
  const ctx=await runtime(new FixtureAdapter(async()=>{
    const index=step++,action=calls[index];
    if(index===1)await busy;
    if(index===4)await f.invoke('chat','send','--json','--kind','request',chat,'sent-during-rearm-window');
    return Array.isArray(action)?{id:`busy-call-${step}`,name:action[0],input:action[1]}:action??'done';
  }));
  const pf=ctx.plugin(plugin,{dataDir:home,relay,wait:'30s',kernelPath:f.binary});await pf;
  t.after(async()=>{releaseBusy();await pf.dispose();await disposeRuntime(ctx);});
  const handle=await ctx.agents.create({sessionId:'native-owner',agentOptions:{provider:'fixture',model:'fixture'}});
  const agent=handle.agent;
  agent.followup(createUserMessage({content:[{type:'text',text:'Run the fixed busy-owner fixture.'}],source:{kind:'user'}}));
  await until(()=>step===2);
  assert.equal(agent.status,'running');
  await f.invoke('chat','send','--json','--kind','request',chat,'busy-owner-message');
  await until(()=>ctx.jobs.list(agent.id).some(j=>j.status==='completed'));
  assert.equal(step,2,'busy model call was not replaced by a new turn');
  releaseBusy();await until(()=>step>=9);await agent.whenIdle();
  const log=agent.session.snapshotEvents();
  assert.ok(JSON.stringify(log.filter(e=>e.type==='tool/result')).includes('sent-during-rearm-window'));
  assert.ok(inspectLocal(home,chat).statistics.plugin.busyNoticesAdmitted>=1);
  // Closing from the peer wakes one final receive, then the plugin refuses rearm.
  await f.invoke('chat','close','--json',chat);
  const armed=await ctx.tools.get('jand_arm',agent).execute({chat},{agent});assert.equal(armed.outcome,'armed');
  await until(()=>ctx.jobs.list(agent.id).filter(j=>j.status==='running').length===0);
  assert.equal((await ctx.tools.get('jand_arm',agent).execute({chat},{agent})).outcome,'ended');
  await handle.dispose();
});

test('owner disposal loses job output but durable inbox recovers under the same session id', {timeout:45_000,skip:!!process.env.DSH_JAND_TEST_RELAY},async t=>{
  const f=await setup(t),{chat,home,relay}=f;
  const ctx=await runtime(new FixtureAdapter(()=>'idle fixture'));
  t.after(()=>disposeRuntime(ctx));
  const manager=new ConversationManager({root:home,jobs:ctx.jobs,relay,wait:'30s',kernel:async()=>f.binary});
  t.after(()=>manager.dispose());
  const handle=await ctx.agents.create({sessionId:'native-owner',agentOptions:{provider:'fixture',model:'fixture'}});
  // Existing native controller still wakes the owner; its fixture has no inbox actions.
  const armed=await manager.arm(chat,handle.agent.id);assert.equal(armed.outcome,'armed');
  await f.invoke('chat','send','--json','--kind','request',chat,'recover-after-owner-disposal');
  await until(()=>ctx.jobs.list(handle.agent.id).some(j=>j.status==='completed'));
  await handle.agent.whenIdle();await handle.dispose();
  const recovered=manager.read(chat,'native-owner');
  assert.ok(recovered.records.some(r=>r.event.text==='recover-after-owner-disposal'));
  assert.throws(()=>manager.read(chat,'different-owner'),/another DSH session/);
  manager.ack(chat,recovered.records.map(r=>r.id),'native-owner');
  // A new live Agent using the exact owner identity can rearm after recovery.
  const resumed=await ctx.agents.create({sessionId:'native-owner',agentOptions:{provider:'fixture',model:'fixture'}});
  assert.equal((await manager.arm(chat,resumed.agent.id)).outcome,'armed');
  await resumed.dispose();
  assert.equal(manager.active.size,0,'owner disposal awaited receiver cancellation');
});

test('real network failure is durably failed with backoff, never no_events',{timeout:45_000,skip:!!process.env.DSH_JAND_TEST_RELAY},async t=>{
  const f=await setup(t),{chat,home,relay}=f;
  const chatFile=path.join(home,'home/chats',chat+'.json');
  const localState=read(chatFile);localState.relay='http://127.0.0.1:1';atomic(chatFile,localState);
  const ctx=await runtime(new FixtureAdapter(()=>'Network failure fixture: no automatic retry.'));
  const manager=new ConversationManager({root:home,jobs:ctx.jobs,relay,wait:'30s',kernel:async()=>f.binary});
  t.after(async()=>{await manager.dispose();await disposeRuntime(ctx);});
  const handle=await ctx.agents.create({sessionId:'native-owner',agentOptions:{provider:'fixture',model:'fixture'}});
  await manager.arm(chat,handle.agent.id);
  await until(()=>ctx.jobs.list(handle.agent.id).some(j=>j.status==='failed'));
  const state=read(layout(home,chat).state);
  assert.equal(state.lastOutcome,'failed');assert.equal(state.failures,1);assert.ok(state.retryAt>Date.now());
  assert.equal(state.records.filter(r=>!state.acked.includes(r.id)).length,0);
  await handle.agent.whenIdle();await handle.dispose();
  const gone=createServer((_req,res)=>{res.writeHead(410);res.end('gone');});
  gone.listen(0,'127.0.0.1');await once(gone,'listening');t.after(()=>gone.close());
  localState.relay=`http://127.0.0.1:${gone.address().port}`;atomic(chatFile,localState);
  state.retryAt=0;state.failures=0;atomic(layout(home,chat).state,state);
  const terminal=await receive({root:home,chat,binary:f.binary,relay,wait:'0s'});
  assert.equal(terminal.outcome,'ended_or_gone');assert.equal(read(layout(home,chat).state).failures,0);
});

test('exit 5 keeps its unread-Relay meaning; receive then reply works before local acknowledgement', {timeout:45_000,skip:!!process.env.DSH_JAND_TEST_RELAY},async t=>{
  const f=await setup(t),manager=new ConversationManager({root:f.home,jobs:null,relay:f.relay,kernel:async()=>f.binary});
  const call=()=>manager.send(f.chat,'native-owner',{kind:'reply',reply_to:'g1',text:'retry-the-same-body'});
  await f.invoke('chat','send','--json','--kind','request',f.chat,'unread-on-relay');
  await assert.rejects(call(),error=>{
    assert.equal(error.code,'JAND_UNREAD_PEER_MESSAGES');assert.equal(error.exitCode,5);assert.equal(error.sent,false);
    assert.match(error.message,/this send was blocked before delivery/);assert.match(error.message,/jand_arm/);assert.match(error.message,/alone do not fetch Relay/);return true;
  });
  assert.equal(manager.read(f.chat,'native-owner').records.length,0,'local inbox cannot preflight unread Relay data');
  const noReply=await f.invoke('chat','recv','--json','--wait','0s',f.chat);assert.ok(!noReply.some(e=>e.kind==='reply'));
  await receive({root:f.home,chat:f.chat,binary:f.binary,relay:f.relay,wait:'0s'});
  const pending=manager.read(f.chat,'native-owner');assert.ok(pending.records.some(r=>r.event.text==='unread-on-relay'));
  const sent=await call();assert.ok(sent.some(e=>e.event==='sent'),'reply allowed after receive but BEFORE ack');
  const peer=await f.invoke('chat','recv','--json','--wait','5s',f.chat);assert.equal(peer.filter(e=>e.text==='retry-the-same-body'&&e.reply_to==='g1').length,1);
  manager.ack(f.chat,pending.records.map(r=>r.id),'native-owner');assert.equal(manager.read(f.chat,'native-owner').records.length,0);
});

test('delivery replacement validates local ownership and existence before sending; current result and history agree',{timeout:45_000,skip:!!process.env.DSH_JAND_TEST_RELAY},async t=>{
 const f=await setup(t),manager=new ConversationManager({root:f.home,jobs:null,relay:f.relay,kernel:async()=>f.binary});
 const first=await manager.send(f.chat,'native-owner',{kind:'delivery',text:'delivery v1'});const firstId=first.find(e=>e.event==='sent').id;
 await f.invoke('chat','recv','--json','--wait','0s',f.chat);
 const peerDelivery=await f.invoke('chat','send','--json','--kind','delivery',f.chat,'peer delivery');const peerId=peerDelivery.find(e=>e.event==='sent').id;
 await receive({root:f.home,chat:f.chat,binary:f.binary,relay:f.relay,wait:'0s'});
 const snapshots=()=>fs.readdirSync(path.join(f.home,'home/chats')).map(name=>[name,fs.readFileSync(path.join(f.home,'home/chats',name)).toString('hex')]);const before=snapshots();
 for(const args of [{kind:'delivery',supersedes:'h99999'},{kind:'delivery',supersedes:peerId},{kind:'note',supersedes:firstId}])await assert.rejects(manager.send(f.chat,'native-owner',{...args,text:'invalid replacement'}),error=>{assert.equal(error.code,'JAND_INVALID_DELIVERY_TARGET');assert.equal(error.sent,false);return true;});
 assert.deepEqual(snapshots(),before,'invalid replacements do not execute the kernel or write chat records');
 const next=await manager.send(f.chat,'native-owner',{kind:'delivery',supersedes:firstId,text:'delivery v2'});const nextId=next.find(e=>e.event==='sent').id;
 const peer=await f.invoke('chat','recv','--json','--wait','5s',f.chat);assert.ok(peer.some(e=>e.id===nextId&&e.supersedes===firstId));
 const view=inspectLocal(f.home,f.chat);assert.ok(!view.results.some(e=>e.id===firstId));assert.ok(view.results.some(e=>e.id===nextId));assert.ok(view.timeline.some(e=>e.id===firstId));
 await assert.rejects(manager.send(f.chat,'native-owner',{kind:'delivery',supersedes:firstId,text:'stale target'}),{code:'JAND_INVALID_DELIVERY_TARGET'});
});
