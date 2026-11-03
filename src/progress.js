// Only relay-created checkpoint text is a protocol reason. Peer text is a summary.
export function checkpointReason(line) {
  if(line?.kind!=='checkpoint')return null;
  if(line.from==='relay')return {all_done:'pauseBothDone',any_done:'pauseOneDone',budget:'pauseLimit'}[line.text]??'pauseUnknown';
  return 'pauseRequested';
}
// Presentation keys only. An open conversation is not evidence of Agent work.
export function progress(detail) {
  const state=detail.status, reception=detail.reception;
  let phase=state==='active'?'conversationOpen':state==='waiting'?'waitingPeer':state==='paused'?'needsDecision':state==='ended'?'conversationEnded':'progressUnknown';
  let next=state==='ended'?'endedNext':state==='paused'?'decideNext':state==='waiting'?'inviteNext':state==='active'?'canIntervene':'unknownNext';
  let receiving='receptionUnknown';
  if(reception?.listener==='running')receiving='receiving';
  else if(reception?.listener==='starting')receiving='startingReception';
  else if(reception?.listener==='stopping')receiving='stoppingReception';
  else if(reception?.listener==='stopped')receiving='receptionStopped';
  // Reception trouble never replaces the conversation's paused/ended/unknown state.
  if(state!=='ended'&&reception?.failures>=5){
    receiving='receptionSuspended';
    if(state==='active'){phase='receptionSuspended';next='retryNext';}
  } else if(state!=='ended'&&reception?.lastOutcome==='failed'&&!['running','starting'].includes(reception?.listener)){
    receiving='receptionFailed';
    if(state==='active'){phase='receptionFailed';next='retryNext';}
  } else if(state==='active'&&reception?.unacknowledged>0){phase='messagesPending';next='pendingNext';}
  if(state==='active'&&phase==='conversationOpen'&&reception?.listener==='stopped')next='resumeNext';
  if(state==='ended')receiving='receptionEnded';
  if(state==='paused'){
    const decision=detail.timeline?.filter(line=>['checkpoint','proposal','resumed','closed','expired'].includes(line.kind)).at(-1);
    if(decision?.kind==='proposal'&&decision.from===detail.role){phase='waitingProposal';next='waitingProposalNext';}
  }
  const recent=detail.timeline?.filter(line=>['message','done'].includes(line.kind)).at(-1)??null;
  const checkpoint=state==='paused'?detail.timeline?.filter(line=>line.kind==='checkpoint').at(-1):null;
  return {phase,next,receiving,recent,reason:checkpointReason(checkpoint)};
}
