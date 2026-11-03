import {listLocal} from './view.js';
import {recordSummary,shortText} from './presentation.js';

export async function readHistory(manager,selected) {
  const rows=listLocal(manager.root),conversations=[],details=new Map();
  // Limit native inspect process concurrency. A per-record failure stays visible;
  // it must not be replaced by a successful local status from a different reader.
  for(let offset=0;offset<rows.length;offset+=4) {
    await Promise.all(rows.slice(offset,offset+4).map(async row=>{
      try {
        const detail=await manager.inspect(row.chat);details.set(row.chat,detail);
        const {goal,latestResults,incomingRequests,outgoingRequests,latest,...summary}=recordSummary(detail);
        conversations.push({...summary,preview:shortText(latest?.text,100)});
      } catch {
        conversations.push({chat:row.chat,title:'',category:'other',state:'recordUnreadable',known:false,messages:null,last:row.last,readError:true});
      }
    }));
  }
  conversations.sort((a,b)=>(b.last??'').localeCompare(a.last??'')||a.chat.localeCompare(b.chat));
  if(selected&&!details.has(selected))throw new Error('Selected collaboration could not be read.');
  return {conversations,detail:selected?details.get(selected):null};
}
