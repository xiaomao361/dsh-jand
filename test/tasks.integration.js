import {isJsonValue} from '@deepseek-ai/dsh-util-values';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {runtime,FixtureAdapter,disposeRuntime} from './runtime.js';
import {TaskLedger} from '../src/tasks.js';
import * as plugin from '../index.js';
const binary=process.env.JAND_TASK_TEST_BINARY;
const until=async p=>{const end=Date.now()+15000;while(!await p()){if(Date.now()>end)throw new Error('task lifecycle evidence timed out');await delay(20);}};
const input=text=>createUserMessage({content:[{type:'text',text}],source:{kind:'user'}});
async function mount(t,root,respond){
 const ctx=await runtime(new FixtureAdapter(respond)),fibers=[];let handle;
 t.after(async()=>{await handle?.dispose();for(const f of fibers.reverse())await f.dispose();await disposeRuntime(ctx);fs.rmSync(root,{recursive:true,force:true});});
 for(const [name,config]of [['dsh-fs-local',{cwd:root}],['dsh-working-directory',{defaultDirectory:root}],['dsh-session-persistence-jsonl',{root:path.join(root,'sessions'),compression:'none'}],['dsh-subagent',{}],['dsh-subagent-spawn-in-process',{}],['dsh-tool-subagent',{provider:'spawn'}],['dsh-tool-subagent-control',{}]]){const m=await import('@deepseek-ai/'+name);const f=ctx.plugin(m.default??m,config);await f;if(f.error)throw f.error;fibers.push(f);}
 const hash=createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
 const f=ctx.plugin(plugin,{dataDir:path.join(root,'jand'),relay:'http://127.0.0.1:1',...(process.env.JAND_TASK_TEST_PUBLISHED?{}:{kernelPath:binary,kernelSha256:hash})});await f;if(f.error)throw f.error;fibers.push(f);
 handle=await ctx.agents.create({sessionId:'local-conversation',agentOptions:{provider:'fixture',model:'fixture'},meta:{cwd:root}});
 const ledger=new TaskLedger({root:path.join(root,'jand'),binary,sha256:hash});
 return {ctx,parent:handle.agent,ledger,tool:(name,args,agent=handle.agent)=>ctx.tools.get(name,agent).execute(args,{agent,signal:new AbortController().signal})};
}
const opts={skip:!binary,timeout:45_000};
test('real DSH three levels: guarded executor, independent coordinator, available conversation, evidence review, no main result wake',opts,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-task-native-'));let release,executorStarted=false,coordSteps=0,execSteps=0,env;
 const gate=new Promise(r=>release=r);t.after(()=>release());
 const a={chat:'a'.repeat(32),phase:'phase-id'};
 const second={chat:'f'.repeat(32),phase:'phase-id'};
 let secondDispatched=false,secondReviewed=false,secondExecuted=false;
 env=await mount(t,root,async options=>{
  const log=JSON.stringify(options.messages);
  if(log.includes('Execute only this bounded locally authorized task.')){
   if(log.includes('Second independent round.')&&!secondExecuted){secondExecuted=true;return {id:'second-command',name:'jand_task_exec',input:{cwd:root,command:'printf second'}};}
   execSteps++;if(execSteps===1){executorStarted=true;await gate;return {id:'managed-command',name:'jand_task_exec',input:{cwd:root,command:'printf checked > evidence.txt'}};}
   return `Execution evidence: ${root}/evidence.txt`;
  }
  if(log.includes('You are the independent coordinator for chat')){
   if(log.includes(second.chat)){
    if(!secondDispatched){secondDispatched=true;return {id:'second-dispatch',name:'jand_task_next',input:second};}
    const run=Object.values(env.ledger.scopes().find(s=>s.scope.chat===second.chat).runs)[0];
    if(run?.state==='result_pending'&&!secondReviewed){
     secondReviewed=true;
     const evidence=await env.tool('jand_task_evidence',{...second,run:run.id});
     assert.match(evidence.commands[0].output,/second/);
     return {id:'second-review',name:'jand_task_review',input:{...second,task:run.task,version:run.version,run:run.id,evidence:'Verified second command output.'}};
    }
    return 'Second round checked.';
   }
   coordSteps++;if(coordSteps>4)return '已查询，没有待执行任务。';
   if(coordSteps===1)return {id:'next',name:'jand_task_next',input:a};
   if(coordSteps===2)return '执行已分派，等待结果。';
   if(coordSteps===4)return '已核对结果。';
   await until(()=>env.ledger.scopes()[0]?.runs&&Object.values(env.ledger.scopes()[0].runs).some(r=>r.state==='result_pending'));
   const s=env.ledger.scopes()[0],run=Object.values(s.runs)[0];
   if(coordSteps===3){assert.equal(fs.readFileSync(path.join(root,'evidence.txt'),'utf8'),'checked');return {id:'review',name:'jand_task_review',input:{...a,task:run.task,version:run.version,run:run.id,evidence:'Read evidence.txt: checked'}};}
   return '已核对结果。';
  }
  return '对话仍可处理补充要求。';
 });
 const submission=await env.tool('jand_task_submit',{...a,event:'local-event',text:'Write evidence.txt with checked and verify the contents.'});
 assert.ok(isJsonValue(submission), 'submission receipt must pass the DSH JSON output contract');
 const queued=await env.tool('jand_task_status',a);
 assert.ok(isJsonValue(queued), 'a task without evidence must still be queryable');
 assert.equal(queued.tasks[0].evidence,null);
 const coord=await env.tool('jand_task_coordinate',a);assert.equal(coord.outcome,'started');await until(()=>executorStarted);
 const s=env.ledger.scopes()[0],run=Object.values(s.runs)[0],child=env.ctx.agents.get(run.session),manager=env.ctx.agents.get(coord.session);
 assert.ok(child&&manager);
 assert.equal(manager.session.header.cwd,root,'coordinator belongs to the main conversation workspace');
 assert.equal(child.session.header.cwd,root,'executor inherits the coordinator workspace');
 assert.equal(child.session.header.parentSession,coord.session);assert.equal(manager.session.header.parentSession,undefined,'coordinator is an independent native session');
 assert.ok(env.ctx.tools.guardReason({name:'subagent',agent:child}));assert.ok(env.ctx.tools.guardReason({name:'jand_arm',agent:manager}));
 assert.equal(env.parent.status,'idle');env.parent.followup(input('Local additional requirement while executor runs'));await env.parent.whenIdle();assert.equal(execSteps,1);
 const before=env.parent.session.snapshotEvents().length;release();
 await until(()=>env.ledger.scopes()[0].tasks[run.task].state==='completed');await until(()=>env.ledger.scopes()[0].coordinator.state==='stopped');
 assert.equal(env.parent.session.snapshotEvents().length,before,'no automatic result notification accumulated in conversation');
 assert.equal(Object.keys(env.ledger.scopes()[0].notices).length,1);
 await until(()=>env.ledger.scopes()[0].coordinator.state==='stopped');
 const continued=await env.tool('jand_task_continue',{...a,event:'one-local-continuation'});assert.equal(continued.outcome,'continued');assert.equal(continued.session,coord.session);
 await until(()=>env.parent.status==='idle'&&env.ledger.scopes()[0].coordinator.state==='stopped');const turns=coordSteps;
 const replay=await env.tool('jand_task_continue',{...a,event:'one-local-continuation'});assert.equal(replay.replayed,true);await delay(50);assert.equal(coordSteps,turns,'same continuation event cannot queue another turn');
 assert.equal(fs.readFileSync(path.join(root,'evidence.txt'),'utf8'),'checked');
 await env.tool('jand_task_submit',{...second,event:'next-round',text:'Second independent round.'});
 const secondCoordinator=await env.tool('jand_task_coordinate',second);
 assert.equal(secondCoordinator.outcome,'started','the next scope must start with the default single coordinator slot');
 assert.notEqual(secondCoordinator.session,coord.session);
 await until(()=>{const round=env.ledger.scopes().find(s=>s.scope.chat===second.chat);return round.coordinator.state==='stopped'&&Object.values(round.tasks).every(task=>task.state==='completed');});
 console.log('Verified actual native conversation → independent coordinator → executor; real managed shell command and evidence review. Deterministic model, query-only notices, no real UI/Relay/account.');
});
test('real native stop drains coordinator/executor and kills foreground shell plus associated child process',opts,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-task-stop-'));let coordSteps=0,execSteps=0;
 const env=await mount(t,root,async options=>{
  const log=JSON.stringify(options.messages);
  if(log.includes('Execute only this bounded locally authorized task.')){
   if(++execSteps===1)return {id:'long-command',name:'jand_task_exec',input:{cwd:root,command:'sleep 60 & echo $! > child.pid; wait'}};
   return 'execution canceled';
  }
  if(log.includes('You are the independent coordinator for chat')){if(++coordSteps===1)return {id:'next',name:'jand_task_next',input:{chat:'b'.repeat(32),phase:'p'}};return '等待执行结果。';}
  return '主对话可用。';
 });
 const a={chat:'b'.repeat(32),phase:'p'};await env.tool('jand_task_submit',{...a,event:'e',text:'Run only the controlled foreground wait command; stop on local request.'});await env.tool('jand_task_coordinate',a);
 await until(()=>fs.existsSync(path.join(root,'child.pid')));const pid=Number(fs.readFileSync(path.join(root,'child.pid'),'utf8'));
 t.after(()=>{try{process.kill(pid,'SIGKILL');}catch{}});
 const before=env.ledger.scopes()[0];env.ledger.call({op:'stop',scope:before.scope,owner:before.owner});
 await until(()=>{const s=env.ledger.scopes()[0];return s.coordinator.state==='stopped'&&Object.values(s.runs).every(r=>r.state==='stopped');});
 const stopped=await env.tool('jand_task_status',a);assert.equal(stopped.halted,true);assert.equal(stopped.coordinator.state,'stopped');assert.equal(stopped.runs[0].state,'stopped');assert.equal(stopped.tasks[0].state,'canceled');
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 assert.equal(env.ctx.agents.get(stopped.coordinator.session),undefined);assert.equal(env.ctx.agents.get(stopped.runs[0].session),undefined);
 const late=await env.tool('jand_task_submit',{...a,event:'after-stop',text:'Do not launch'});assert.equal(late.outcome,'halted');assert.equal(Object.values(env.ledger.scopes()[0].runs).length,1);
 await env.tool('jand_task_resume',a);const continued=await env.tool('jand_task_continue',{...a,event:'explicit-resume'});assert.equal(continued.outcome,'continued');assert.equal(continued.session,stopped.coordinator.session);await until(()=>env.ctx.agents.get(continued.session)?.status==='idle');await env.tool('jand_task_stop',a);
 console.log('Verified durable cutoff before native tree drain; actual shell + child PID gone; no post-stop dispatch; inbox ownership/remote close untouched.');
});
test('running revision stops old process before new version dispatch; late old evidence cannot finish replacement',opts,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-task-revision-'));let dispatched=false;const execVersions=new Set();const a={chat:'c'.repeat(32),phase:'same-phase'};
 const env=await mount(t,root,async options=>{
  const log=JSON.stringify(options.messages);
  if(log.includes('Execute only this bounded locally authorized task.')){
   const v2=log.includes('version 2.');
   if(!execVersions.has(v2?2:1)){execVersions.add(v2?2:1);return {id:v2?'new-command':'old-command',name:'jand_task_exec',input:{cwd:root,command:v2?'printf new > result.txt':'sleep 60 & echo $! > old.pid; wait; printf stale > result.txt'}};}
   return v2?'Replacement result: result.txt contains new':'Old result must remain canceled';
  }
  if(log.includes('You are the independent coordinator for chat')){if(!dispatched){dispatched=true;return {id:'dispatch-old',name:'jand_task_next',input:a};}return '请查询持久结果。';}
  return '对话可用。';
 });
 const submitted=await env.tool('jand_task_submit',{...a,event:'original',text:'Controlled foreground work with cancelable process.'});await env.tool('jand_task_coordinate',a);
 await until(()=>fs.existsSync(path.join(root,'old.pid')));const oldPid=Number(fs.readFileSync(path.join(root,'old.pid')));t.after(()=>{try{process.kill(oldPid,'SIGKILL');}catch{}});
 const changed=await env.tool('jand_task_revise',{...a,event:'local-change',task:submitted.task.id,version:1,text:'Write new into result.txt; old execution must be stopped first.'});
 assert.equal(changed.stop.runs[0].state,'stopped');assert.throws(()=>process.kill(oldPid,0),{code:'ESRCH'});
 const s=env.ledger.scopes()[0],coordinator=env.ctx.agents.get(s.coordinator.session);const started=await env.tool('jand_task_next',a,coordinator);assert.equal(started.version,2);
 await until(()=>Object.values(env.ledger.scopes()[0].runs).some(r=>r.version===2&&r.state==='result_pending'));
 assert.equal(fs.readFileSync(path.join(root,'result.txt'),'utf8'),'new');const status=await env.tool('jand_task_status',a);assert.equal(status.tasks[0].state,'blocked','exit does not accept new version');
 const old=status.runs.find(r=>r.version===1);await assert.rejects(env.tool('jand_task_review',{...a,task:submitted.task.id,version:2,run:old.id,evidence:'late old result'}),/current result/);
 const current=status.runs.find(r=>r.version===2);await env.tool('jand_task_review',{...a,task:submitted.task.id,version:2,run:current.id,evidence:'Read result.txt: new; old process PID gone'});
 assert.equal((await env.tool('jand_task_status',a)).tasks[0].state,'completed');await env.tool('jand_task_stop',a);
});
test('real command failure cannot become a successful result from a model completion claim',opts,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-task-failure-'));let dispatched=false,executed=false;const a={chat:'d'.repeat(32),phase:'failure-proof'};
 const env=await mount(t,root,async options=>{
  const log=JSON.stringify(options.messages);
  if(log.includes('Execute only this bounded locally authorized task.')){if(!executed){executed=true;return {id:'fails',name:'jand_task_exec',input:{cwd:root,command:'exit 7'}};}return 'Claim: everything succeeded';}
  if(log.includes('You are the independent coordinator for chat')){if(!dispatched){dispatched=true;return {id:'next',name:'jand_task_next',input:a};}return '结果需查询。';}return '主对话可用。';
 });
 const submitted=await env.tool('jand_task_submit',{...a,event:'e',text:'Exercise only the controlled failing command.'});await env.tool('jand_task_coordinate',a);
 await until(()=>env.ledger.scopes()[0].tasks[submitted.task.id].state==='failed');const run=Object.values(env.ledger.scopes()[0].runs)[0];assert.equal(run.state,'failed');
 const evidence=await env.tool('jand_task_evidence',{...a,run:run.id});assert.equal(evidence.commands[0].state,'failed');await assert.rejects(env.tool('jand_task_review',{...a,task:run.task,version:run.version,run:run.id,evidence:'model claim'}),/current result/);await env.tool('jand_task_stop',a);
});
