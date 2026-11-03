import {runKernel} from './kernel.js';
import {timelineRecord} from './view.js';

const states=new Set(['complete','partial','missing','empty','broken']);
const sectionStates=new Set([...states,'unavailable']);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const normalizeState=s=>s==='broken'?'corrupt':s==='complete'?'valid':s;
function totals(value,records=null) {
  if(value===null||value===undefined)return null;
  if(!['wakes','empty_wakes','decisions','out_bytes','wrote_bytes'].every(k=>integer(value[k])))throw new Error('Invalid native inspect totals.');
  return {recvReturns:value.wakes,emptyReturns:value.empty_wakes,decisionCommands:value.decisions,cliOutputBytes:value.out_bytes,writtenBytes:value.wrote_bytes,commandFailures:records===null?null:records.filter(r=>r.exit!==0).length};
}
export function adaptInspect(snapshot,base) {
  if(snapshot?.schema_version!==1||snapshot.scope!=='local'||snapshot.chat?.chat!==base.chat||!states.has(snapshot.transcript_integrity?.state)||!states.has(snapshot.cost?.integrity?.state)||!Array.isArray(snapshot.timeline)||!Array.isArray(snapshot.sections)||!Array.isArray(snapshot.messages)||!Array.isArray(snapshot.cost.records))throw new Error('Unsupported or invalid native inspect schema.');
  if(!snapshot.timeline.every(l=>l&&typeof l.time==='string'&&Number.isFinite(Date.parse(l.time))&&typeof l.kind==='string'))throw new Error('Invalid native timeline.');
  const timeline=snapshot.timeline.map(timelineRecord),records=snapshot.cost.records;
  if(!records.every(r=>typeof r.time==='string'&&Number.isFinite(Date.parse(r.time))&&typeof r.cmd==='string'&&integer(r.out)&&(r.wrote===undefined||integer(r.wrote))&&integer(r.exit)&&['empty','check','own'].every(k=>r[k]===undefined||typeof r[k]==='boolean')))throw new Error('Invalid native cost records.');
  const recordView=records.map(r=>({time:r.time,cmd:r.cmd,out:r.out,wrote:r.wrote??0,empty:!!r.empty,check:!!r.check,own:!!r.own,exit:r.exit}));
  const segments=snapshot.sections.map((section,sectionIndex)=>{
    if(!integer(section.n)||typeof section.goal!=='string'||typeof section.started!=='string'||!Number.isFinite(Date.parse(section.started))||!Array.isArray(section.timeline_indexes)||!section.timeline_indexes.every(i=>integer(i)&&i<timeline.length)||!sectionStates.has(section.cost_state))throw new Error('Invalid native inspect section.');
    if(['missing','empty','broken','unavailable'].includes(section.cost_state)&&section.cost!==null)throw new Error('Native section has totals without coverage.');
    const next=snapshot.sections[sectionIndex+1];
    const attributed=snapshot.transcript_integrity.state==='complete'?records.filter(r=>Date.parse(r.time)>=Date.parse(section.started)&&(!next||Date.parse(r.time)<Date.parse(next.started))):null;
    return {number:section.n,goal:section.goal,started:section.started,budget:section.budget??null,events:section.timeline_indexes.map(i=>timeline[i]),outcome:section.outcome??null,costState:normalizeState(section.cost_state)==='valid'?'complete':normalizeState(section.cost_state),cost:totals(section.cost,attributed)};
  });
  const pendingIds=new Set(snapshot.messages.filter(m=>m.pending&&m.kind==='request').map(m=>m.id));
  const currentDeliveries=new Set(snapshot.messages.filter(m=>m.kind==='delivery'&&!m.superseded_by).map(m=>m.id));
  const result={...base,source:'native_inspect',capability:{inspect:true,schema_version:1},role:snapshot.chat.role,status:snapshot.chat.status,goal:snapshot.chat.goal??'',timeline,segments,pendingRequests:timeline.filter(l=>pendingIds.has(l.id)),results:timeline.filter(l=>l.kind==='done'||(l.kind==='message'&&currentDeliveries.has(l.id))),
    statistics:{...base.statistics,jand:totals(snapshot.cost.totals,records),costRecords:recordView,integrity:{...base.statistics.integrity,transcript:normalizeState(snapshot.transcript_integrity.state),cost:normalizeState(snapshot.cost.integrity.state),costCoverage:snapshot.cost.integrity.state==='complete'?'complete':normalizeState(snapshot.cost.integrity.state)}}};
  if(!['complete','partial'].includes(snapshot.cost.integrity.state)&&result.statistics.jand!==null)throw new Error('Native inspect returned usable totals for unavailable cost data.');
  return result;
}
export async function inspectKernel(binary,root,chat,base,{runner=runKernel}={}) {
  // An unknown subcommand in the released 0.4.6 can append a cost record and
  // refresh HTML before returning usage. Probe a command with NO chat id first.
  const help=await runner(binary,['chat','--help'],{home:root+'/home',timeout:15_000,json:false});
  if(help.code!==0||typeof help.stdout!=='string')throw new Error('Inspect capability probe failed.');
  if(!/\bjand\s+chat\s+inspect\s+--json\b/.test(help.stdout))return {...base,source:'local_files',capability:{inspect:false,reason:'not_advertised'}};
  const result=await runner(binary,['chat','inspect','--json',chat],{home:root+'/home',timeout:15_000});
  // Advertised but failed commands or unknown schemas remain explicit errors.
  if(result.code!==0||result.events.length!==1)throw new Error('Native inspect failed; its result was not replaced by local success.');
  return adaptInspect(result.events[0],base);
}
