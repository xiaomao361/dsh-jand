import test from 'node:test';
import assert from 'node:assert/strict';
import {recordSummary,shortText,historyTotals,conversationBrief} from '../src/presentation.js';
import {readHistory} from '../src/history.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {atomic} from '../src/store.js';
function viewFixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-history-')),chat='a'.repeat(32),dir=path.join(root,'home/chats');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));atomic(path.join(dir,chat+'.json'),{id:chat,role:'host'});fs.writeFileSync(path.join(dir,chat+'.transcript.jsonl'),JSON.stringify({time:'2026-11-02T08:00:00Z',kind:'started',from:'host',text:'goal'})+'\n');return {root,chat};}
const event=(kind,from,text='',extra={})=>({time:'2026-11-02T08:00:00Z',kind,from,text,...extra});
function detail(timeline,extra={}) {return {chat:'a'.repeat(32),role:'host',status:'active',timeline,segments:[{goal:'A goal',events:timeline}],pendingRequests:[],results:[],statistics:{integrity:{transcript:'valid'}},reception:{listener:'stopped',lastOutcome:'canceled'},...extra};}

test('invitations, exchanges and goal phases are different concepts',()=>{
 const invitation=recordSummary(detail([event('started','host','invite')],{status:'waiting'}));
 assert.equal(invitation.category,'invitation');assert.equal(invitation.state,'invitationSent');assert.equal(invitation.messages,0);
 const events=[event('started','host'),event('joined','guest'),...Array.from({length:32},(_,i)=>event('message',i%2?'host':'guest','message',{id:String(i),type:'reply'}))];
 const result=recordSummary(detail(events));assert.equal(result.category,'conversation');assert.equal(result.messages,32);assert.equal(result.state,'receptionStopped');
 assert.ok(!Object.hasOwn(result,'rounds'),'goal phase count is not a user-facing exchange count');
});
test('a local open record never claims active work, a canceled listener never closes the conversation',()=>{
 const events=[event('joined','guest'),event('message','guest','hello')];
 assert.equal(recordSummary(detail(events)).state,'receptionStopped');
 assert.equal(recordSummary(detail(events,{reception:{listener:'running'}})).state,'receiving');
 assert.equal(recordSummary(detail(events,{reception:{listener:'unknown'}})).state,'recordOpen');
 assert.equal(recordSummary(detail(events)).protocol,'active');
 assert.equal(recordSummary(detail(events,{status:'ended'})).state,'recordEnded');
});
test('completion claims remain attributed, current results and requests do not include earlier goals',()=>{
 const old=event('message','guest','old request',{id:'g1',type:'request'}),oldResult=event('message','guest','old delivery',{id:'g2',type:'delivery'});
 const now=event('done','guest','claimed done');
 const current=[event('resumed','host','new goal'),now];
 const data=detail([old,oldResult,...current],{segments:[{events:[old,oldResult]},{events:current}],pendingRequests:[old],results:[oldResult,now]});
 const result=recordSummary(data);assert.equal(result.state,'peerReported');assert.equal(result.incoming,0);assert.deepEqual(result.latestResults,[now]);
});
test('missing or broken records cannot become zero messages or invitations',()=>{
 const result=recordSummary(detail([],{statistics:{integrity:{transcript:'corrupt'}}}));
 assert.equal(result.messages,null);assert.equal(result.category,'other');assert.equal(result.state,'recordUnknown');
 assert.equal(shortText('x'.repeat(5000),100).length,101);
});
test('history lists local summaries without inspecting details and only loads the selected record',async t=>{
 const f=viewFixture(t);let calls=0;
 const v=detail([event('joined','guest'),event('message','guest','x'.repeat(50000),{type:'delivery'})],{chat:f.chat});
 const manager={root:f.root,inspect:async chat=>{assert.equal(chat,f.chat);calls++;return v;}};
 const list=await readHistory(manager);assert.equal(calls,0);assert.equal(list.conversations.length,1);
 assert.ok(JSON.stringify(list.conversations).length<2000,'list payload does not contain full bodies');
 const result=await readHistory(manager,f.chat);assert.equal(calls,1);assert.equal(result.detail,v);
 manager.inspect=async()=>{throw Error('private diagnostic');};
 await assert.rejects(()=>readHistory(manager,f.chat),/could not be read/);
});

test('overview preserves unknown counts and distinguishes records from exchanges',()=>{
 assert.deepEqual(historyTotals([]),{records:0,conversations:0,invitations:0,unknown:0,messages:0});
 assert.equal(historyTotals([{messages:null,category:'other'}]).messages,null);
 const total=historyTotals([{messages:32,category:'conversation'},{messages:0,category:'invitation'},{messages:null,category:'other'}]);
 assert.deepEqual(total,{records:3,conversations:1,invitations:1,unknown:1,messages:32});
 assert.equal(historyTotals([{messages:Number.MAX_SAFE_INTEGER},{messages:1}]).messages,null);
});

test('brief attributes latest messages within the current goal and keeps partial evidence explicit',()=>{
 const old=event('done','guest','Old finished goal');
 const host=event('message','host','Please retest',{type:'request'});
 const earlier=event('message','guest','Working',{type:'progress'});
 const latest=event('done','guest','Reported fixed, awaiting your check');
 const current=[host,earlier,latest];
 const source=detail([old,...current],{segments:[{goal:'Old',events:[old]},{goal:'Retest',events:current}]});
 const brief=conversationBrief(source);
 assert.equal(brief.goal,'Retest');assert.deepEqual(brief.updates,[host,latest]);assert.equal(brief.known,true);
 source.statistics.integrity.transcript='partial';assert.equal(conversationBrief(source).known,false);
 assert.deepEqual(conversationBrief(detail([])).updates,[]);
});
