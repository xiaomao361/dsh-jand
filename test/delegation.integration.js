import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {runtime,FixtureAdapter,disposeRuntime} from './runtime.js';
import * as plugin from '../index.js';

const until=async predicate=>{const end=Date.now()+10_000;while(!predicate()){if(Date.now()>end)throw new Error('Native delegation evidence timed out.');await delay(10);}};
const input=text=>createUserMessage({content:[{type:'text',text}],source:{kind:'user'}});

test('native asynchronous child leaves coordinator idle, accepts new input and reports final evidence', {timeout:30_000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-jand-delegation-'));
  let release,childStarted=false,childFinished=false,parentStep=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const ctx=await runtime(new FixtureAdapter(async options=>{
    const messages=JSON.stringify(options.messages);
    if(!messages.includes('COORDINATOR_START')) {
      childStarted=true;await gate;childFinished=true;
      return '阶段：已完成。已做：确定性检查。结果与证据：fixture-check=passed。阻塞：无。需要用户决定：否。';
    }
    parentStep++;
    if(parentStep===1)return {id:'delegate-1',name:'subagent',input:{description:'Run fixed child check',prompt:'CHILD_ONLY_TASK: Run the authorized deterministic fixture. Report stage, work done, result evidence, blockers and user decision needed. Do not bind or receive the jand chat.'}};
    if(messages.includes('fixture-check=passed'))return '已核对执行结果：检查通过，无需你操作。';
    if(messages.includes('USER_ADDED_REQUIREMENT'))return '已收到补充要求，执行任务仍在子会话中。';
    return '已安排执行，完成后会汇报。你可以继续补充要求。';
  }));
  const fibers=[];let handle;
  t.after(async()=>{release();await handle?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();await disposeRuntime(ctx);fs.rmSync(root,{recursive:true,force:true});});
  const mount=async(name,config={})=>{const m=await import('@deepseek-ai/'+name);const fiber=ctx.plugin(m.default??m,config);await fiber;if(fiber.error)throw fiber.error;fibers.push(fiber);};
  await mount('dsh-fs-local',{cwd:root});
  await mount('dsh-working-directory',{defaultDirectory:root});
  await mount('dsh-session-persistence-jsonl',{root:path.join(root,'sessions'),compression:'none'});
  await mount('dsh-subagent');
  await mount('dsh-subagent-spawn-in-process');
  await mount('dsh-tool-subagent',{provider:'spawn'});
  await mount('dsh-tool-subagent-control');
  const fiber=ctx.plugin(plugin,{dataDir:path.join(root,'jand'),relay:'http://127.0.0.1:1',wait:'1s'});await fiber;fibers.push(fiber);
  handle=await ctx.agents.create({sessionId:'coordinator-fixture',agentOptions:{provider:'fixture',model:'fixture'},cwd:root});
  const parent=handle.agent;
  parent.followup(input('COORDINATOR_START: Delegate the fixed child check, keep the conversation available.'));
  await parent.whenIdle();await until(()=>childStarted);
  assert.equal(parent.status,'idle');assert.equal(childFinished,false,'parent must be idle before child finishes');
  const before=parent.session.snapshotEvents();
  const start=before.find(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('started subagent'));
  assert.ok(start,'native subagent tool returns child identity without final output');
  assert.ok(JSON.stringify(before).includes('已安排执行'));
  parent.followup(input('USER_ADDED_REQUIREMENT: Keep the original scope.'));
  await parent.whenIdle();
  assert.equal(childFinished,false);assert.equal(parent.status,'idle');
  assert.ok(JSON.stringify(parent.session.snapshotEvents()).includes('已收到补充要求'));
  release();await until(()=>childFinished);
  await until(()=>JSON.stringify(parent.session.snapshotEvents()).includes('已核对执行结果'));
  await parent.whenIdle();
  const events=JSON.stringify(parent.session.snapshotEvents());
  assert.ok(events.includes('fixture-check=passed'),'completion notice returns child evidence to parent');
  assert.ok(events.includes('jand')||ctx.tools.get('jand_inbox',parent),'communication tools remain on coordinator');
  console.log('Verified: native subagent start acknowledgement → coordinator idle while child runs → new user input handled → native completion result reviewed. Deterministic model; no UI or production profile.');
});

test('native cancel returns promptly and cancellation completion stays distinct from task success', {timeout:30_000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-jand-cancel-'));
  let childStarted=false,childAborted=false,handle;
  const ctx=await runtime(new FixtureAdapter(async options=>{
    if(JSON.stringify(options.messages).includes('CHILD_CANCEL_TASK')) {
      childStarted=true;
      await new Promise((resolve,reject)=>{
        const abort=()=>{childAborted=true;reject(options.signal.reason??new Error('Fixture aborted'));};
        if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
      });
      return 'Unexpected task success';
    }
    return '已请求停止，等待确认实际停止。';
  }));
  const fibers=[];
  t.after(async()=>{await handle?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();await disposeRuntime(ctx);fs.rmSync(root,{recursive:true,force:true});});
  for(const [name,config]of [
    ['dsh-fs-local',{cwd:root}],['dsh-working-directory',{defaultDirectory:root}],
    ['dsh-session-persistence-jsonl',{root:path.join(root,'sessions'),compression:'none'}],
    ['dsh-subagent',{}],['dsh-subagent-spawn-in-process',{}],['dsh-tool-subagent',{provider:'spawn'}],['dsh-tool-subagent-control',{}]
  ]){const m=await import('@deepseek-ai/'+name);const fiber=ctx.plugin(m.default??m,config);await fiber;if(fiber.error)throw fiber.error;fibers.push(fiber);}
  handle=await ctx.agents.create({sessionId:'cancel-coordinator-fixture',agentOptions:{provider:'fixture',model:'fixture'},cwd:root});
  const parent=handle.agent,signal=new AbortController().signal;
  const started=await ctx.tools.get('subagent',parent).execute({description:'Cancelable fixed child task',prompt:'CHILD_CANCEL_TASK: Wait for native cancellation. Do not start descendants.'},{agent:parent,signal});
  assert.equal(started.kind,'activation');assert.ok(started.subagentId);
  await until(()=>childStarted);assert.equal(parent.status,'idle');
  const canceled=await ctx.tools.get('interrupt_agent',parent).execute({agent_id:started.subagentId},{agent:parent,signal});
  assert.deepEqual(canceled,{accepted:true},'native cancel result is a request acknowledgement');
  await until(()=>childAborted);
  await until(()=>parent.session.snapshotEvents().some(e=>e.type==='agent/inbox/spliced'&&JSON.stringify(e.data).includes(started.subagentId)));
  await parent.whenIdle();
  const log=JSON.stringify(parent.session.snapshotEvents());
  assert.ok(!log.includes('Unexpected task success'));
  assert.ok(/interrupt|cancel|killed/i.test(log),'native completion preserves interruption rather than task success');
  console.log('Verified: native interrupt accepted → child AbortSignal observed → parent completion notice preserves interruption. No remote chat was closed.');
});
