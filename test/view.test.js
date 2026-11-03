import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {atomic} from '../src/store.js';
import {inspectLocal,listLocal} from '../src/view.js';
const chat='c'.repeat(32),time='2026-10-30T10:00:00Z';
export function viewFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-view-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'home/chats');fs.mkdirSync(dir,{recursive:true});
  atomic(path.join(dir,chat+'.json'),{id:chat,role:'host',relay:'https://fixture.example',token:'protocol-secret-should-not-leak',key:'encryption-secret-should-not-leak'});
  const write=(suffix,rows)=>fs.writeFileSync(path.join(dir,chat+suffix),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  write('.transcript.jsonl',[{time,kind:'started',from:'host',text:'Agreed fixture',budget:10},{time,kind:'joined',from:'guest'},{time,kind:'message',from:'guest',id:'g1',type:'request',text:'<img src=x onerror=alert(1)>'},{time,kind:'message',from:'host',id:'h1',type:'reply',reply_to:'g1',text:'fixed reply'}]);
  write('.cost.jsonl',[{time,cmd:'start',out:100,exit:0},{time,cmd:'recv',out:80,empty:true,exit:0},{time,cmd:'recv',out:40,check:true,exit:0},{time,cmd:'send',out:20,wrote:11,exit:0}]);
  return {root,dir,chat,write};
}
test('native view preserves raw business meaning and never serializes protocol secrets',t=>{
  const f=viewFixture(t),v=inspectLocal(f.root,chat);
  assert.equal(v.statistics.jand.recvReturns,1);assert.equal(v.statistics.jand.emptyReturns,1);assert.equal(v.statistics.jand.cliOutputBytes,240);assert.equal(v.statistics.jand.writtenBytes,11);
  assert.equal(v.statistics.plugin,null);assert.equal(v.statistics.tokenUsage,null);assert.equal(v.pendingRequests.length,0);assert.equal(v.status,'active');
  assert.equal(v.timeline[2].text,'<img src=x onerror=alert(1)>');
  assert.ok(!JSON.stringify(v).includes('should-not-leak'));assert.equal(listLocal(f.root).length,1);
  const before=fs.readdirSync(f.dir).map(n=>[n,fs.readFileSync(path.join(f.dir,n)).toString('hex')]);inspectLocal(f.root,chat);
  assert.deepEqual(fs.readdirSync(f.dir).map(n=>[n,fs.readFileSync(path.join(f.dir,n)).toString('hex')]),before);
});
test('missing, empty and corrupt records do not become zero totals or active status',t=>{
  const f=viewFixture(t);fs.writeFileSync(path.join(f.dir,chat+'.cost.jsonl'),'');
  assert.equal(inspectLocal(f.root,chat).statistics.jand,null);
  fs.writeFileSync(path.join(f.dir,chat+'.cost.jsonl'),'{broken}\n');
  assert.equal(inspectLocal(f.root,chat).statistics.integrity.cost,'corrupt');assert.equal(inspectLocal(f.root,chat).statistics.jand,null);
  fs.unlinkSync(path.join(f.dir,chat+'.transcript.jsonl'));
  assert.equal(inspectLocal(f.root,chat).status,'unknown');
});
test('DSH admitted idle wakes and busy notices stay separate from recv returns',t=>{
  const f=viewFixture(t);const rows=[
    {kind:'notice',chat,jobId:'jand-a',owner:'owner',seq:1,delivery:'wakeup_queued'},
    {kind:'notice',chat,jobId:'jand-a',owner:'owner',seq:2,delivery:'admitted'},
    {kind:'notice',chat,jobId:'jand-b',owner:'owner',seq:3,delivery:'busy_injected'},
    {kind:'notice',chat,jobId:'jand-b',owner:'owner',seq:4,delivery:'admitted'},
    {kind:'tool_output',chat,owner:'owner',seq:5,bytes:42}
  ].map(r=>({schema_version:1,time,...r}));
  fs.writeFileSync(path.join(f.root,'plugin-metrics.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n'));
  const stats=inspectLocal(f.root,chat).statistics;assert.equal(stats.plugin.wakesAdmitted,1);assert.equal(stats.plugin.busyNoticesAdmitted,1);assert.equal(stats.plugin.toolResultBytes,42);
});
test('separate failed jobs from the same owner are not merged when seq is absent',t=>{
  const f=viewFixture(t);
  const rows=['jand-first','jand-second'].map(jobId=>({schema_version:1,time,kind:'job_finished',chat,jobId,owner:'owner',outcome:'failed'}));
  fs.writeFileSync(path.join(f.root,'plugin-metrics.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n'));
  assert.equal(inspectLocal(f.root,chat).statistics.plugin.receiveFailures,2);
});
test('overflowing totals are unavailable, never silently rounded into usable statistics',t=>{
  const f=viewFixture(t);
  f.write('.cost.jsonl',[{time,cmd:'start',out:Number.MAX_SAFE_INTEGER,exit:0},{time,cmd:'send',out:1,exit:0}]);
  const result=inspectLocal(f.root,chat);
  assert.equal(result.statistics.jand,null);assert.equal(result.statistics.integrity.cost,'overflow');
});
test('late-started cost history leaves earlier goal totals unknown and partitions same-second boundaries into the next goal',t=>{
  const f=viewFixture(t),next='2026-10-30T10:01:00Z';
  f.write('.transcript.jsonl',[{time,kind:'started',from:'host',text:'goal one'},{time:next,kind:'resumed',from:'relay',text:'goal two'}]);
  f.write('.cost.jsonl',[{time:next,cmd:'recv',out:12,exit:0}]);
  const v=inspectLocal(f.root,chat);assert.equal(v.segments[0].cost,null);assert.equal(v.segments[0].costState,'missing');assert.equal(v.segments[1].cost.cliOutputBytes,12);assert.equal(v.segments[1].costState,'partial');
});
test('local fallback keeps superseded delivery in history but excludes it from current results',t=>{
 const f=viewFixture(t);f.write('.transcript.jsonl',[
  {time,kind:'started',from:'host',text:'goal'},
  {time,kind:'message',from:'guest',id:'g1',type:'delivery',text:'old'},
  {time,kind:'message',from:'guest',id:'g2',type:'delivery',supersedes:'g1',text:'current'}
 ]);const value=inspectLocal(f.root,chat);assert.deepEqual(value.results.map(r=>r.id),['g2']);assert.ok(value.timeline.some(r=>r.id==='g1'));
});

test('host invitation waits for peer join without creating an empty second goal',t=>{
 const f=viewFixture(t);
 const started={time,kind:'started',from:'host',text:'agreed goal'};
 f.write('.transcript.jsonl',[started]);
 let value=inspectLocal(f.root,chat);assert.equal(value.status,'waiting');assert.equal(value.goal,'agreed goal');assert.equal(value.segments.length,1);
 f.write('.transcript.jsonl',[started,{time,kind:'joined',from:'guest'}]);
 value=inspectLocal(f.root,chat);assert.equal(value.status,'active');assert.equal(value.goal,'agreed goal');assert.equal(value.segments.length,1);
 f.write('.transcript.jsonl',[started,{time,kind:'decline',from:'guest'}]);
 assert.equal(inspectLocal(f.root,chat).status,'ended');
});

test('history counts independent collaboration IDs, keeps goal rounds within one record, and preserves unknown counts',t=>{
 const f=viewFixture(t),next='2026-10-30T11:00:00Z';
 f.write('.transcript.jsonl',[
  {time,kind:'started',from:'host',text:'First objective'},
  {time,kind:'joined',from:'guest'},
  {time,kind:'checkpoint',from:'relay',text:'budget'},
  {time:next,kind:'resumed',from:'relay',text:'Second objective'},
  {time:next,kind:'message',from:'guest',id:'g1',type:'progress',text:'Working'}
 ]);
 const second='b'.repeat(32);
 atomic(path.join(f.dir,second+'.json'),{id:second,role:'host'});
 fs.writeFileSync(path.join(f.dir,second+'.transcript.jsonl'),'{broken}\n');
 const rows=listLocal(f.root);assert.equal(rows.length,2);
 const row=rows.find(r=>r.chat===chat);assert.equal(row.rounds,2);assert.equal(row.initialGoal,'First objective');assert.equal(row.goal,'Second objective');assert.equal(row.started,time);assert.equal(row.messages,1);
 const broken=rows.find(r=>r.chat===second);assert.equal(broken.messages,null);assert.equal(broken.rounds,null);assert.equal(broken.status,'unknown');
 f.write('.transcript.jsonl',[{time:next,kind:'resumed',from:'relay',text:'Retained tail only'}]);
 assert.equal(listLocal(f.root).find(r=>r.chat===chat).rounds,null,'a retained tail cannot prove the full round count');
});
