import fs from 'node:fs';
import path from 'node:path';
import { chatId,read } from './store.js';

const MAX=16*1024*1024;
function lines(file,validate=()=>true) {
  try {
    if(fs.statSync(file).size>MAX)return {integrity:'too_large',records:[]};
    const content=fs.readFileSync(file,'utf8');const records=[];
    for(const [index,line]of content.split('\n').entries()) {
      if(!line.trim())continue;
      try{const value=JSON.parse(line);if(!validate(value))throw Error();records.push(value);}catch{return {integrity:'corrupt',line:index+1,records:[]};}
    }
    return {integrity:records.length?'valid':'empty',records};
  } catch(error){return {integrity:error.code==='ENOENT'?'missing':'unavailable',records:[]};}
}
const isLine=x=>x&&typeof x==='object'&&!Array.isArray(x)&&typeof x.time==='string'&&Number.isFinite(Date.parse(x.time))&&typeof x.kind==='string';
const isCost=x=>x&&typeof x.time==='string'&&Number.isFinite(Date.parse(x.time))&&typeof x.cmd==='string'&&Number.isSafeInteger(x.out)&&x.out>=0&&Number.isSafeInteger(x.exit)&&['wrote'].every(k=>x[k]===undefined||(Number.isSafeInteger(x[k])&&x[k]>=0))&&['empty','check','own'].every(k=>x[k]===undefined||typeof x[k]==='boolean');
const isMetric=x=>x&&x.schema_version===1&&typeof x.time==='string'&&Number.isFinite(Date.parse(x.time))&&/^[a-f0-9]{32}$/.test(x.chat)&&typeof x.owner==='string'&&['job_registered','job_finished','notice','tool_output'].includes(x.kind)&&(x.kind!=='tool_output'||(Number.isSafeInteger(x.bytes)&&x.bytes>=0))&&(x.kind!=='notice'||(['wakeup_queued','busy_injected','admitted'].includes(x.delivery)&&typeof x.jobId==='string'));
const text=(v,max=65536)=>typeof v==='string'?v.slice(0,max):'';
function sumCost(records) {
  const s={cliOutputBytes:0,writtenBytes:0,recvReturns:0,emptyReturns:0,commandFailures:0,decisionCommands:0};
  for(const r of records){s.cliOutputBytes+=r.out;s.writtenBytes+=r.wrote??0;if(r.cmd==='recv'&&!r.check&&!r.own){s.recvReturns++;if(r.empty)s.emptyReturns++;}if(r.exit!==0)s.commandFailures++;if(r.exit===0&&['join','propose','accept','close','checkpoint'].includes(r.cmd))s.decisionCommands++;}
  return Object.values(s).every(Number.isSafeInteger)?s:null;
}
export function timelineRecord(line) {
  const value={time:line.time,from:text(line.from,32),kind:line.kind};
  for(const key of ['id','type','reply_to','supersedes','text','workflow','mode'])if(typeof line[key]==='string')value[key]=text(line[key]);
  for(const key of ['budget','step'])if(Number.isSafeInteger(line[key]))value[key]=line[key];
  if(Array.isArray(line.plan))value.plan=line.plan.map(p=>({goal:text(p.goal,1024),budget:Number.isSafeInteger(p.budget)?p.budget:null}));
  value.untrusted=true;return value;
}
function readTranscript(root,chat) {
  chatId(chat);const directory=path.join(root,'home/chats');
  const raw=read(path.join(directory,chat+'.json'),null);
  if(!raw||raw.id!==chat)throw new Error('Conversation not found in this plugin.');
  const transcript=lines(path.join(directory,chat+'.transcript.jsonl'),isLine);
  const timeline=transcript.records.map(timelineRecord);
  const initial=timeline.find(l=>['started','joined'].includes(l.kind));
  const segments=[];let segment;
  for(const line of timeline) {
    if(['started','resumed'].includes(line.kind)||(line.kind==='joined'&&raw.role!=='host')) {
      segment={number:segments.length+1,goal:line.text??'',started:line.time,budget:line.budget??null,events:[],outcome:null};segments.push(segment);
    }
    if(segment){segment.events.push(line);if(['checkpoint','closed','expired'].includes(line.kind))segment.outcome=line.kind;}
  }
  const state=read(path.join(root,'conversations',chat,'inbox.json'),null);
  const lastState=timeline.filter(l=>['started','joined','resumed','checkpoint','closed','expired','decline','declined'].includes(l.kind)).at(-1)?.kind;
  const status=transcript.integrity!=='valid'||!initial?'unknown':state?.ended?'ended':['closed','expired','decline','declined'].includes(lastState)?'ended':lastState==='checkpoint'?'paused':lastState==='started'&&raw.role==='host'?'waiting':lastState?'active':'unknown';
  return {chat,role:['host','guest'].includes(raw.role)?raw.role:'unknown',status,goal:segments.at(-1)?.goal??initial?.text??'',segments,timeline,state,integrity:transcript.integrity};
}

export function inspectTranscript(root,chat) {
  const {state,integrity,...view}=readTranscript(root,chat);
  return {...view,statistics:{integrity:{transcript:integrity}},reception:state?{failures:state.failures,lastOutcome:state.lastOutcome}:null};
}

export function inspectLocal(root,chat) {
  const {state,integrity,...view}=readTranscript(root,chat);
  const {segments,timeline}=view;
  const directory=path.join(root,'home/chats');
  const cost=lines(path.join(directory,chat+'.cost.jsonl'),isCost);
  const metrics=lines(path.join(root,'plugin-metrics.jsonl'),isMetric);
  const ownedMetrics=metrics.records.filter(m=>m.chat===chat);
  const costsComplete=cost.integrity==='valid'&&cost.records.length>0&&['start','claim'].includes(cost.records[0].cmd);
  let costStats=cost.integrity==='valid'&&cost.records.length?cost.records.reduce((s,r)=>{
    s.cliOutputBytes+=r.out;s.writtenBytes+=r.wrote??0;
    if(r.cmd==='recv'&&!r.check&&!r.own){s.recvReturns++;if(r.empty)s.emptyReturns++;}
    if(r.exit!==0)s.commandFailures++;
    if(r.exit===0&&['join','propose','accept','close','checkpoint'].includes(r.cmd))s.decisionCommands++;
    return s;
  },{cliOutputBytes:0,writtenBytes:0,recvReturns:0,emptyReturns:0,commandFailures:0,decisionCommands:0}):null;
  const costOverflow=costStats&&!Object.values(costStats).every(Number.isSafeInteger);
  if(costOverflow)costStats=null;
  const firstCostTime=cost.records.length?Date.parse(cost.records[0].time):Infinity;
  for(const [index,section]of segments.entries()) {
    const start=Date.parse(section.started),end=segments[index+1]?Date.parse(segments[index+1].started):Infinity;
    section.costState=costOverflow?'overflow':cost.integrity!=='valid'?cost.integrity:end<=firstCostTime?'missing':costsComplete||start>firstCostTime?'complete':'partial';
    section.cost=['complete','partial'].includes(section.costState)?sumCost(cost.records.filter(r=>Date.parse(r.time)>=start&&Date.parse(r.time)<end)):null;
    if(['complete','partial'].includes(section.costState)&&section.cost===null)section.costState='overflow';
  }
  let pluginStats=metrics.integrity==='valid'?{wakesAdmitted:0,busyNoticesAdmitted:0,toolResultBytes:0,receiveFailures:0,receiveCancellations:0,measurementStarted:metrics.records[0]?.time??null}:null;
  if(pluginStats) {
    const notices=new Map();const seen=new Set();
    for(const m of ownedMetrics) {
      const key=m.owner+':'+(m.seq??m.jobId)+':'+m.kind+':'+(m.delivery??'');if(seen.has(key))continue;seen.add(key);
      if(m.kind==='notice'&&['wakeup_queued','busy_injected'].includes(m.delivery))notices.set(m.jobId,m.delivery);
      if(m.kind==='notice'&&m.delivery==='admitted') {
        if(notices.get(m.jobId)==='wakeup_queued')pluginStats.wakesAdmitted++;
        if(notices.get(m.jobId)==='busy_injected')pluginStats.busyNoticesAdmitted++;
      }
      if(m.kind==='tool_output'&&Number.isSafeInteger(m.bytes))pluginStats.toolResultBytes+=m.bytes;
      if(m.kind==='job_finished'&&m.outcome==='failed')pluginStats.receiveFailures++;
      if(m.kind==='job_finished'&&m.outcome==='canceled')pluginStats.receiveCancellations++;
    }
  }
  const metricsOverflow=pluginStats&&!Number.isSafeInteger(pluginStats.toolResultBytes);
  if(metricsOverflow)pluginStats=null;
  const replied=new Set(timeline.filter(l=>l.reply_to).map(l=>l.reply_to));
  const superseded=new Set(timeline.filter(l=>l.kind==='message'&&l.supersedes).map(l=>l.supersedes));
  const pending=timeline.filter(l=>l.kind==='message'&&l.type==='request'&&l.id&&!replied.has(l.id));
  return {schema_version:1,...view,pendingRequests:pending,
    results:timeline.filter(l=>l.kind==='done'||(l.kind==='message'&&l.type==='delivery'&&!superseded.has(l.id))),
    statistics:{jand:costStats,plugin:pluginStats,tokenUsage:null,integrity:{transcript:integrity,cost:costOverflow?'overflow':cost.integrity,metrics:metricsOverflow?'overflow':metrics.integrity,costCoverage:costOverflow?'overflow':costsComplete?'complete':cost.integrity==='valid'?'partial':cost.integrity},costRecords:cost.integrity==='valid'?cost.records.map(r=>({time:r.time,cmd:r.cmd,out:r.out,wrote:r.wrote??0,empty:!!r.empty,check:!!r.check,own:!!r.own,exit:r.exit})):[]},
    reception:state?{ended:state.ended,failures:state.failures,retryAt:state.retryAt,lastOutcome:state.lastOutcome,unacknowledged:state.records.filter(r=>!state.acked.includes(r.id)).length}:null};
}
export function localChatIds(root) {
  const directory=path.join(root,'home/chats');
  if(!fs.existsSync(directory))return [];
  return fs.readdirSync(directory).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>n.slice(0,32));
}

export function listLocal(root) {
  return localChatIds(root).map(chat=>{
    try{
      const v=inspectLocal(root,chat),known=v.statistics.integrity.transcript==='valid';
      const started=v.timeline.find(l=>['started','joined'].includes(l.kind))?.time??null;
      return {chat,goal:v.goal,initialGoal:v.segments[0]?.goal??'',status:v.status,
        started,rounds:known&&started&&v.segments.length?v.segments.length:null,
        messages:known?v.timeline.filter(l=>l.kind==='message').length:null,
        last:v.timeline.at(-1)?.time??null,integrity:v.statistics.integrity};
    }
    catch{return {chat,goal:'',status:'unavailable',messages:null,last:null};}
  }).sort((a,b)=>(b.last??'').localeCompare(a.last??''));
}
