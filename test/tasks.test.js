import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DSHTasks,TaskLedger} from '../src/tasks.js';
const binary=process.env.JAND_TASK_TEST_BINARY;
const sha256=binary?createHash('sha256').update(fs.readFileSync(binary)).digest('hex'):null;
function fixture(t,{depth=2,cancel=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-tasks-unit-'));const bound=new Map(),agents=new Map();
 const ctx={tools:{guard(){}},get:n=>n==='subagents'?ctx.subagents:n==='agents'?ctx.agents:undefined,agents:{get:id=>agents.get(id)},subagents:{getProvider:()=>({prepareContinuable(){},capabilities:{depthLimit:true}}),resolveMaxDepth:()=>depth,startActivation:async()=>{throw new Error('start unconfirmed');},...(cancel?{drainChildren:async()=>{},drainDescendants:async()=>{}}:{})}};
 const manager={root,bind(chat,o){if(bound.has(chat)&&bound.get(chat)!==o)throw new Error('owner');bound.set(chat,o);},ownerOf:chat=>bound.get(chat)};
 const tasks=new DSHTasks({ctx,manager,binary,sha256});const parent={id:'owner',session:{header:{}}};
 t.after(async()=>{await tasks.dispose();fs.rmSync(root,{recursive:true,force:true});});return {tasks,parent,root,ctx,agents};
}
const options={skip:!binary};
test('release controller resolves lazily and validates its pin',options,()=>{
 let pin;const ledger=new TaskLedger({root:os.tmpdir(),resolveController:()=>pin});
 assert.equal(ledger.probe().available,false);
 pin={binary,sha256};assert.equal(ledger.probe().available,true);
 pin={binary,sha256:'0'.repeat(64)};assert.equal(ledger.probe().available,false);
 assert.throws(()=>ledger.call({op:'status'}),/TASK_CONTROLLER_UNAVAILABLE/);
});
test('capability downgrade comes from actual adapter APIs and depth',options,async t=>{
 for(const [depth,cancel,expected]of [[2,true,'three_level'],[1,true,'two_level'],[0,true,'manual'],[2,false,'manual']]){
  const {tasks,parent}=fixture(t,{depth,cancel});assert.equal(tasks.capability(parent).mode,expected);
 }
});
test('duplicate submissions cannot launch coordinators; failed startup keeps exact reserved identity across adapter restart',options,async t=>{
 const {tasks,parent,ctx,root}=fixture(t);const a={chat:'chat',phase:'p',event:'evt',text:'do bounded work'};
 const [first,again]=await Promise.all([tasks.submit(a,parent),tasks.submit(a,parent)]);assert.equal(first.task.id,again.task.id);
 await assert.rejects(tasks.coordinate(a,parent),/unconfirmed/);const state=tasks.state(a.chat,a.phase,parent),session=state.coordinator.session;
 const restarted=new DSHTasks({ctx,manager:tasks.manager,binary,sha256});const r=await restarted.coordinate(a,parent);assert.equal(r.outcome,'existing');assert.equal(r.coordinator.session,session);assert.equal(r.coordinator.state,'unknown');
 const stopped=await restarted.stop(a,parent);assert.equal(stopped.halted,true);assert.equal(stopped.coordinator.state,'unknown','absence/no-op drain must not certify stop after crash');
 assert.equal(fs.existsSync(root),true);await restarted.dispose();
});
test('unknown host startup survives restart and stop failure without redispatch',options,async t=>{
 const {tasks,parent,ctx}=fixture(t,{depth:1});const a={chat:'chat',phase:'p',event:'evt',text:'task'};await tasks.submit(a,parent);
 const start=await tasks.next(a,parent);assert.equal(start.outcome,'unknown');
 const next=await tasks.next(a,parent);assert.notEqual(next.outcome,'started');
 const stop=await tasks.stop(a,parent);assert.equal(stop.runs[0].state,'unknown');assert.equal(stop.halted,true);
 const restarted=new DSHTasks({ctx,manager:tasks.manager,binary,sha256});const recovered=await restarted.reconcile(a,parent);assert.equal(recovered.runs[0].state,'unknown');assert.equal((await restarted.next(a,parent)).outcome,'halted');await restarted.dispose();
});
test('adapter cancellation failure remains unknown; controller cutoff precedes host calls',options,async t=>{
 const {tasks,parent,ctx,agents}=fixture(t,{depth:1});const a={chat:'c',phase:'p',event:'e',text:'task'};await tasks.submit(a,parent);await tasks.next(a,parent);const run=Object.values(tasks.ledger.scopes()[0].runs)[0];agents.set(parent.id,parent);agents.set(run.session,{id:run.session,session:{header:{parentSession:parent.id}}});
 let called=0;ctx.subagents.drainDescendants=async()=>{called++;assert.equal(tasks.state(a.chat,a.phase,parent).halted,true);throw new Error('host cancellation failed');};
 const result=await tasks.stop(a,parent);assert.equal(result.runs[0].state,'unknown');assert.equal(called,1);
 assert.equal(tasks.guard({agent:{id:result.runs[0].session},name:'jand_task_exec'}).includes('fenced'),true);
});
test('stop races an in-flight host start: no new dispatch, late receipt is disposed, old completion cannot complete task',options,async t=>{
 const {tasks,parent,ctx}=fixture(t,{depth:1});const a={chat:'c',phase:'p',event:'input',text:'bounded task'};await tasks.submit(a,parent);
 let release,disposed=0;ctx.subagents.startActivation=()=>new Promise(resolve=>{release=()=>resolve({childId:tasks.ledger.scopes()[0].runs[Object.keys(tasks.ledger.scopes()[0].runs)[0]].session,result:new Promise(()=>{}),dispose:async()=>{disposed++;}});});
 const starting=tasks.next(a,parent);assert.ok(release);const stopped=await tasks.stop(a,parent);assert.equal(stopped.halted,true);assert.equal(stopped.runs[0].state,'unknown');
 release();await starting;assert.equal(disposed,1);const s=tasks.ledger.scopes()[0];assert.notEqual(Object.values(s.tasks)[0].state,'completed');assert.equal((await tasks.next(a,parent)).outcome,'halted');
});
test('one actual command admission per run; concurrent tool calls cannot bypass process limit',options,async t=>{
 const {tasks,parent,root}=fixture(t,{depth:1});const a={chat:'c',phase:'p',event:'e',text:'bounded command'};await tasks.submit(a,parent);const s=tasks.state(a.chat,a.phase,parent),r=tasks.request(s,'reserve').run;const agent={id:r.session};const controller=new AbortController();
 const first=tasks.execute({cwd:root,command:'sleep 30'},agent,controller.signal);t.after(()=>controller.abort());
 await assert.rejects(tasks.execute({cwd:root,command:'printf forbidden'},agent,controller.signal),/slot full/);controller.abort();const result=await first;assert.equal(result.state,'stopped');
});

// Idle hosts must not pay for control monitoring: the tick reads persisted scope
// records instead of spawning the controller once per scope.
test('control monitor reads persisted scope state and never spawns the controller',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-tasks-monitor-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const ctx={tools:{guard(){}},get:()=>undefined};
 const tasks=new DSHTasks({ctx,manager:{root,ownerOf:()=>null,bind(){}},binary:null,sha256:null});
 const stops=[];let kernel=0;
 tasks.finishStop=async s=>{stops.push(s.scope.phase);};
 tasks.ledger={root:path.join(root,'tasks'),local:()=>({states:[{scope:{host:'dsh',chat:'c',phase:'p'},owner:'o',halted:true,control_id:2}],unreadable:0}),scopes:()=>{kernel++;return [];}};
 await tasks.checkControls();
 assert.deepEqual(stops,['p']);
 await tasks.checkControls();
 assert.deepEqual(stops,['p'],'one finish per control id');
 assert.equal(tasks.monitorFailed,false);
 await tasks.dispose();
 assert.equal(kernel,0,'idle ticks must not query the controller');
});

test('planned scopes are not stopped; unreadable records surface degraded monitoring',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-tasks-monitor-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const ctx={tools:{guard(){}},get:()=>undefined};
 const tasks=new DSHTasks({ctx,manager:{root,ownerOf:()=>null,bind(){}},binary:null,sha256:null});
 let stops=0;tasks.finishStop=async()=>{stops++;};
 tasks.ledger={root:path.join(root,'tasks'),local:()=>({states:[{scope:{host:'dsh',chat:'c',phase:'planned'},owner:'o',halted:false,control_id:0}],unreadable:1})};
 await tasks.checkControls();
 assert.equal(stops,0);
 assert.equal(tasks.monitorFailed,true);
 tasks.ledger.local=()=>({states:[],unreadable:0});
 await tasks.checkControls();
 assert.equal(tasks.monitorFailed,false,'monitoring recovers once records are readable');
 await tasks.dispose();
});

test('ledger.local reads scope records, skips unreadable files and picks up rewrites',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-tasks-local-'));try{
  const ledger=new TaskLedger({root,binary:'/nonexistent/jand',sha256:'0'.repeat(64)});
  fs.mkdirSync(ledger.root,{recursive:true});
  const one=path.join(ledger.root,'a'.repeat(64)+'.json'),two=path.join(ledger.root,'b'.repeat(64)+'.json');
  fs.writeFileSync(one,JSON.stringify({scope:{chat:'c'},owner:'o',halted:false,control_id:0}));
  fs.writeFileSync(two,'{not json');
  const first=ledger.local();assert.equal(first.states.length,1);assert.equal(first.unreadable,1);
  fs.writeFileSync(one,JSON.stringify({scope:{chat:'c'},owner:'o',halted:true,control_id:3}));
  fs.writeFileSync(two,JSON.stringify({scope:{chat:'d'},owner:'o',halted:false,control_id:0}));
  const second=ledger.local();assert.equal(second.states.length,2);assert.equal(second.unreadable,0);
  assert.equal(second.states.find(s=>s.scope.chat==='c').halted,true,'rewritten records are re-read');
  assert.equal(ledger.local().states.length,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('controller pin is hashed once per file version and still rejects drift',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-task-pin-'));try{
  const file=path.join(root,'jand');fs.writeFileSync(file,'abc');
  const ledger=new TaskLedger({root,binary:file,sha256:createHash('sha256').update('abc').digest('hex')});
  assert.equal(ledger.pinned(),true);
  assert.equal(ledger.pinned(),true);
  fs.writeFileSync(file,'abcd');
  assert.equal(ledger.pinned(),false,'changed binary content invalidates the cached digest');
  assert.throws(()=>ledger.call({op:'status'}),/TASK_CONTROLLER_UNAVAILABLE/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
