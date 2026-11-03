import fs from 'node:fs';
import path from 'node:path';

export function metric(root,event) {
  const fd=fs.openSync(path.join(root,'plugin-metrics.jsonl'),'a',0o600);
  try{fs.writeSync(fd,JSON.stringify({schema_version:1,time:new Date().toISOString(),...event})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function observeSession(manager,session,event) {
  if(event.type==='tool/call'&&event.data.name?.startsWith('jand_')) {
    let args=event.data.arguments;
    if(typeof args==='string'){try{args=JSON.parse(args);}catch{return;}}
    if(/^[a-f0-9]{32}$/.test(args?.chat))manager.toolBindings.set(session.id+':'+event.data.callId,args.chat);
    return;
  }
  if(event.type==='tool/result') {
    const key=session.id+':'+event.data.message?.toolCallId,chat=manager.toolBindings.get(key);
    if(chat){metric(manager.root,{kind:'tool_output',chat,owner:session.id,seq:event.seq,bytes:Buffer.byteLength(JSON.stringify(event.data.message.content))});manager.toolBindings.delete(key);}
    return;
  }
  if(event.type!=='agent/inbox/spliced'&&event.type!=='user/message')return;
  const messages=event.type==='user/message'?[event.data]:(event.data.inserted??[]);
  for(const message of messages) {
    if(message?.source?.kind!=='tool-jobs')continue;
    const text=(message.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    const ids=[...text.matchAll(/\bjand-[a-f0-9]{16}\b/g)].map(x=>x[0]);
    for(const id of new Set(ids)) {
      const binding=manager.jobBindings.get(id);
      if(!binding||binding.owner!==session.id)continue;
      const delivery=event.type==='user/message'?'admitted':event.data.target==='next-turn'?'wakeup_queued':'busy_injected';
      metric(manager.root,{kind:'notice',chat:binding.chat,jobId:id,owner:session.id,seq:event.seq,delivery});
      if(delivery==='admitted')manager.jobBindings.delete(id);
    }
  }
}
