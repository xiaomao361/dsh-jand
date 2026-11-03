import {inspectTranscript,localChatIds} from './view.js';
import {recordSummary} from './presentation.js';

export async function readHistory(manager,selected) {
  if(selected) {
    try{return {detail:await manager.inspect(selected)};}
    catch{throw new Error('Selected collaboration could not be read.');}
  }
  const conversations=localChatIds(manager.root).map(chat=>{
    try {
      const view=inspectTranscript(manager.root,chat);
      const listener=manager.active?.get(chat);
      view.reception={...view.reception,listener:listener?.canceled?'stopping':listener?.id?'running':listener?'starting':'stopped'};
      return recordSummary(view,{listOnly:true});
    } catch {
      return {chat,title:'',category:'other',state:'recordUnreadable',known:false,messages:null,last:null};
    }
  });
  conversations.sort((a,b)=>(b.last??'').localeCompare(a.last??'')||a.chat.localeCompare(b.chat));
  return {conversations,detail:null};
}
