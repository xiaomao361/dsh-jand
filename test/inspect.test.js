import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {adaptInspect,inspectKernel} from '../src/inspect.js';
import {prepare,sha256,shippedManifest} from '../src/kernel.js';
const fixture=()=>JSON.parse(fs.readFileSync(new URL('./fixtures/inspect-schema1.json',import.meta.url)));
const base=()=>({chat:fixture().chat.chat,reception:null,statistics:{plugin:null,tokenUsage:null,integrity:{metrics:'missing'}}});
test('command/schema probe accepts same-version local inspect and falls back only on explicit unsupported command',async()=>{
  const snapshot=fixture();let called=0;
  const help={code:0,stdout:'jand chat inspect --json <chat>'};
  const value=await inspectKernel('same-0.4.6','/isolated',snapshot.chat.chat,base(),{runner:async(_bin,args)=>{called++;if(args[1]==='--help')return help;assert.deepEqual(args,['chat','inspect','--json',snapshot.chat.chat]);return {code:0,events:[snapshot]};}});
  assert.equal(value.source,'native_inspect');assert.equal(value.statistics.jand.cliOutputBytes,snapshot.cost.totals.out_bytes);assert.equal(called,2);
  const old=await inspectKernel('old-0.4.6','/isolated',snapshot.chat.chat,base(),{runner:async(_bin,args)=>{assert.deepEqual(args,['chat','--help']);return {code:0,stdout:'jand chat recv <chat>'};}});assert.equal(old.source,'local_files');assert.equal(old.capability.inspect,false);
  await assert.rejects(inspectKernel('bad','/isolated',snapshot.chat.chat,base(),{runner:async(_b,args)=>args[1]==='--help'?help:({code:1,events:[]})}),/not replaced/);
  snapshot.schema_version=2;await assert.rejects(inspectKernel('future','/isolated',fixture().chat.chat,base(),{runner:async(_b,args)=>args[1]==='--help'?help:({code:0,events:[snapshot]})}),/schema/);
});
test('native authority preserves missing/partial totals and explicit note reply linkage',()=>{
  const snapshot=fixture();
  const request=snapshot.messages.find(m=>m.kind==='request');request.pending=false;request.answers=['h-note'];
  snapshot.timeline.push({time:'2026-10-30T01:07:00Z',from:'host',kind:'message',id:'h-note',type:'note',reply_to:request.id,text:'explicit note reply'});
  const mapped=adaptInspect(snapshot,base());assert.ok(!mapped.pendingRequests.some(m=>m.id===request.id));
  snapshot.cost.integrity={state:'partial',started_late:true,reason:'unterminated_tail',valid_lines:1};
  snapshot.sections[0].cost_state='missing';snapshot.sections[0].cost=null;
  const partial=adaptInspect(snapshot,base());assert.equal(partial.segments[0].cost,null);assert.equal(partial.segments[0].costState,'missing');assert.equal(partial.statistics.integrity.costCoverage,'partial');
  snapshot.cost.integrity.state='broken';snapshot.cost.totals=null;assert.equal(adaptInspect(snapshot,base()).statistics.jand,null);
});
test('dev kernel override requires explicit hash, uses isolated content-addressed cache and preserves release manifest',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-dev-pin-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binary=path.join(root,'source'),bytes=Buffer.from('synthetic local build, not executed');fs.writeFileSync(binary,bytes);
  const manifest=shippedManifest(),before=JSON.stringify(manifest);
  const prepared=await prepare(root,manifest,{existingPath:binary,existingSha256:sha256(bytes)});
  assert.ok(prepared.includes('local-'+sha256(bytes)));assert.equal(fs.readFileSync(prepared).toString(),bytes.toString());assert.equal(JSON.stringify(manifest),before);
  await assert.rejects(prepare(root,manifest,{existingPath:binary,existingSha256:'f'.repeat(64)}),/checksum mismatch/);
  await assert.rejects(prepare(root,manifest,{existingSha256:sha256(bytes)}),/requires/);
});
test('native section unavailability and superseded deliveries remain distinct',()=>{
 const snapshot=fixture();snapshot.sections[0].cost_state='unavailable';snapshot.sections[0].cost=null;
 const deliveries=snapshot.messages.filter(m=>m.kind==='delivery');
 if(deliveries.length){deliveries[0].superseded_by='new-delivery';}
 const value=adaptInspect(snapshot,base());assert.equal(value.segments[0].costState,'unavailable');assert.equal(value.segments[0].cost,null);
 if(deliveries.length)assert.ok(!value.results.some(r=>r.id===deliveries[0].id));
});
test('actual released 0.4.6 help probe leaves the complete home unchanged',async t=>{
 const binary=path.resolve('.local/test-kernel/kernels/0.4.6/darwin-arm64/jand');
 if(process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(binary)){t.skip('local released macOS kernel unavailable');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jand-old-probe-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home');fs.mkdirSync(path.join(home,'chats'),{recursive:true});
 fs.writeFileSync(path.join(home,'chats','sentinel.cost.jsonl'),'original cost\n');fs.writeFileSync(path.join(home,'sentinel.html'),'original page');
 const hashes=()=>fs.readdirSync(home,{recursive:true}).filter(f=>fs.statSync(path.join(home,f)).isFile()).map(f=>[f,sha256(fs.readFileSync(path.join(home,f)))]).sort();
 const before=hashes(),result=await inspectKernel(binary,root,fixture().chat.chat,base());assert.equal(result.source,'local_files');assert.deepEqual(hashes(),before);
});
test('native section failure counts use goal time boundaries including equal-second transitions',()=>{
 const snapshot=fixture();assert.ok(snapshot.sections.length>=2);
 const boundary=snapshot.sections[1].started;
 snapshot.cost.records.push({time:boundary,cmd:'send',out:0,exit:2});
 const mapped=adaptInspect(snapshot,base());assert.equal(mapped.segments[0].cost.commandFailures,0);assert.equal(mapped.segments[1].cost.commandFailures,1);assert.equal(mapped.statistics.jand.commandFailures,1);
 snapshot.transcript_integrity.state='partial';for(const section of snapshot.sections){section.cost_state='unavailable';section.cost=null;}
 assert.equal(adaptInspect(snapshot,base()).segments[1].cost,null);
});
