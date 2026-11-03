// Browser-safe presentation. These labels describe retained evidence, never live peer work.
export function shortText(value,limit=100) {
  const text=typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
  return text.length>limit?text.slice(0,limit)+'…':text;
}
export function recordSummary(detail,{listOnly=false}={}) {
  const timeline=detail.timeline??[],messages=timeline.filter(l=>l.kind==='message');
  const known=detail.statistics?.integrity?.transcript==='valid';
  const first=timeline.find(l=>['started','joined'].includes(l.kind));
  const goal=detail.segments?.[0]?.goal||first?.text||detail.goal||'';
  const title=shortText(goal.split(/[\n。；：]/)[0]||goal,36);
  const peer=l=>['host','guest'].includes(l.from)&&l.from!==detail.role;
  const hasPeer=messages.some(peer);
  const invitation=known&&detail.role==='host'&&first?.kind==='started'&&!hasPeer&&!messages.length&&!timeline.some(l=>l.kind==='joined');
  const category=!known?'other':hasPeer?'conversation':invitation?'invitation':'other';
  const current=detail.segments?.at(-1)?.events??timeline;
  const done=current.filter(l=>l.kind==='done').at(-1);
  const listener=detail.reception?.listener??'unknown';
  let state=!known?'recordUnknown':detail.status==='ended'?'recordEnded':detail.status==='paused'?'recordPaused':invitation?'invitationSent':done?(peer(done)?'peerReported':'selfReported'):listener==='running'?'receiving':listener==='starting'?'startingReception':listener==='stopping'?'stoppingReception':listener==='stopped'?'receptionStopped':'recordOpen';
  if(known&&['active','waiting'].includes(detail.status)&&!invitation&&(detail.reception?.failures>=5||(detail.reception?.lastOutcome==='failed'&&!['running','starting'].includes(listener))))state='receptionSuspended';
  const summary={chat:detail.chat,title,category,state,known,last:timeline.at(-1)?.time??null,messages:known?messages.length:null};
  if(listOnly)return summary;
  const currentKeys=new Set(current.map(l=>JSON.stringify(l)));
  const pending=(detail.pendingRequests??[]).filter(l=>currentKeys.has(JSON.stringify(l)));
  const results=(detail.results??[]).filter(l=>currentKeys.has(JSON.stringify(l)));
  const latestBySide=new Map();
  for(const line of results)if(['host','guest'].includes(line.from))latestBySide.set(line.from,line);
  const latestResults=[...latestBySide.values()];
  const incoming=pending.filter(peer),outgoing=pending.filter(l=>l.from===detail.role);
  return {...summary,goal,listener,protocol:detail.status,
    started:first?.time??null,recordedMessages:messages.length,
    incoming:incoming.length,outgoing:outgoing.length,latestResults,
    incomingRequests:incoming,outgoingRequests:outgoing,
    latest:timeline.filter(l=>l.kind==='message'||l.kind==='done').at(-1)??null};
}

export function historyTotals(items) {
  const known=items.filter(item=>Number.isSafeInteger(item.messages)&&item.messages>=0);
  const sum=known.reduce((total,item)=>total+item.messages,0);
  return {records:items.length,conversations:items.filter(item=>item.category==='conversation').length,
    invitations:items.filter(item=>item.category==='invitation').length,
    unknown:items.length-known.length,messages:(!items.length||known.length)&&Number.isSafeInteger(sum)?sum:null};
}

// Extractive brief: each statement remains attributable to a recorded message.
export function conversationBrief(detail) {
  const current=detail.segments?.at(-1);
  const events=current?.events??detail.timeline??[];
  const latest=new Map();
  for(const line of events)if(['host','guest'].includes(line.from)&&
    (line.kind==='done'||line.kind==='message')&&typeof line.text==='string'&&line.text.trim())latest.set(line.from,line);
  return {goal:current?.goal||detail.goal||recordSummary(detail).goal,
    updates:[...latest.values()],known:detail.statistics?.integrity?.transcript==='valid'};
}
