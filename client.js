window.__ModuleLoader__.load({id:'@xiaomao361/dsh-jand',factory(require){
const React=require('react');const {z}=require('zod');
// Shared, browser-safe wire contract. Host and Client use the same schemas.
function panelSpec(z) {
  const schemas={read:z.strictObject({chat:z.string().regex(/^[a-f0-9]{32}$/).optional()}),configure:z.strictObject({relay:z.string().optional(),token_file:z.string().optional()}),prepare:z.strictObject({}),saveToken:z.strictObject({value:z.string().min(1).max(8192)})};
  return {package:'@xiaomao361/dsh-jand',methods:Object.fromEntries(Object.entries(schemas).map(([name,schema])=>{
    const codec={mode:'strict',typeSymbol:`@xiaomao361/dsh-jand#${name}`,create:()=>schema,jsonSchema:z.toJSONSchema(schema)};
    return ['jandPanel/'+name,{service:'jandPanel',invocation:{kind:'direct'},parameters:[{name:'request',wire:'request',source:'json',codec,strictCodec:codec}],result:{mode:'strict',typeSymbol:'@xiaomao361/dsh-jand#result',create:()=>z.json(),jsonSchema:{}}}];
  }))};
}
function clientContribution(z) {
  const spec=panelSpec(z);
  return {package:spec.package,descriptors:Object.entries(spec.methods).map(([endpoint,definition])=>({...definition,id:spec.package+'#'+endpoint,namespace:'jandPanel',method:endpoint.split('/')[1]}))};
}

// Only relay-created checkpoint text is a protocol reason. Peer text is a summary.
function checkpointReason(line) {
  if(line?.kind!=='checkpoint')return null;
  if(line.from==='relay')return {all_done:'pauseBothDone',any_done:'pauseOneDone',budget:'pauseLimit'}[line.text]??'pauseUnknown';
  return 'pauseRequested';
}
// Presentation keys only. An open conversation is not evidence of Agent work.
function progress(detail) {
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

// Browser-safe presentation. These labels describe retained evidence, never live peer work.
function shortText(value,limit=100) {
  const text=typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
  return text.length>limit?text.slice(0,limit)+'…':text;
}
function recordSummary(detail) {
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
  const currentKeys=new Set(current.map(l=>JSON.stringify(l)));
  const pending=(detail.pendingRequests??[]).filter(l=>currentKeys.has(JSON.stringify(l)));
  const results=(detail.results??[]).filter(l=>currentKeys.has(JSON.stringify(l)));
  const latestBySide=new Map();
  for(const line of results)if(['host','guest'].includes(line.from))latestBySide.set(line.from,line);
  const latestResults=[...latestBySide.values()];
  const done=current.filter(l=>l.kind==='done').at(-1);
  const listener=detail.reception?.listener??'unknown';
  let state=!known?'recordUnknown':detail.status==='ended'?'recordEnded':detail.status==='paused'?'recordPaused':invitation?'invitationSent':done?(peer(done)?'peerReported':'selfReported'):listener==='running'?'receiving':listener==='starting'?'startingReception':listener==='stopping'?'stoppingReception':listener==='stopped'?'receptionStopped':'recordOpen';
  if(known&&['active','waiting'].includes(detail.status)&&!invitation&&(detail.reception?.failures>=5||(detail.reception?.lastOutcome==='failed'&&!['running','starting'].includes(listener))))state='receptionSuspended';
  const incoming=pending.filter(peer),outgoing=pending.filter(l=>l.from===detail.role);
  return {chat:detail.chat,title,goal,category,state,listener,protocol:detail.status,known,
    started:first?.time??null,last:timeline.at(-1)?.time??null,
    messages:known?messages.length:null,recordedMessages:messages.length,
    incoming:incoming.length,outgoing:outgoing.length,latestResults,
    incomingRequests:incoming,outgoingRequests:outgoing,
    latest:timeline.filter(l=>l.kind==='message'||l.kind==='done').at(-1)??null};
}

function historyTotals(items) {
  const known=items.filter(item=>Number.isSafeInteger(item.messages)&&item.messages>=0);
  const sum=known.reduce((total,item)=>total+item.messages,0);
  return {records:items.length,conversations:items.filter(item=>item.category==='conversation').length,
    invitations:items.filter(item=>item.category==='invitation').length,
    unknown:items.length-known.length,messages:(!items.length||known.length)&&Number.isSafeInteger(sum)?sum:null};
}

// Extractive brief: each statement remains attributable to a recorded message.
function conversationBrief(detail) {
  const current=detail.segments?.at(-1);
  const events=current?.events??detail.timeline??[];
  const latest=new Map();
  for(const line of events)if(['host','guest'].includes(line.from)&&
    (line.kind==='done'||line.kind==='message')&&typeof line.text==='string'&&line.text.trim())latest.set(line.from,line);
  return {goal:current?.goal||detail.goal||recordSummary(detail).goal,
    updates:[...latest.values()],known:detail.statistics?.integrity?.transcript==='valid'};
}

const zh={
 language:'zh-CN',nav:'jand 协作',title:'jand 协作',help:'帮助',settings:'设置',refresh:'刷新',refreshing:'正在更新…',back:'返回记录',backHome:'返回',loading:'正在读取…',failed:'未能读取。请检查连接后刷新重试。',refreshFailed:'更新失败，以下保留上次读取的记录。请稍后重试。',saved:'设置已保存。',prepared:'准备完成。',failedAction:'操作未完成，请检查网络和设置后重试。',copyFailed:'未能复制，请直接选取下面的文字。',copied:'已复制，粘贴到聊天中即可。',
 ready:'插件已准备好',canJoin:'可以加入协作',prepareTitle:'先完成插件准备',prepareHint:'只需下载一次运行文件，插件会自动校验并使用。',prepare:'准备插件',preparing:'正在准备…',offline:'暂时无法连接',offlineHint:'请检查网络，或在设置中检查服务地址。',accessHint:'发起协作还需设置访问权限。',access:'设置权限',quickStart:'快速开始',quickHint:'在聊天中告诉助手目标，或粘贴收到的邀请链接。',start:'发起协作',join:'加入协作',
 startTitle:'让助手发起协作',startHint:'回到聊天，告诉助手这次要一起完成什么。确认目标后，助手会生成邀请链接。',startExample:'我想和另一台设备上的助手协作。请先和我确认目标和分工，再生成邀请链接。',joinTitle:'让助手接收邀请',joinHint:'把收到的邀请链接粘贴到聊天中，请助手先说明协作目标。你同意后再加入。',joinExample:'请查看这个协作邀请，先向我说明目标和分工，等我同意后再加入。',copyExample:'复制给助手',backToChat:'复制后关闭设置，回到当前聊天粘贴发送。',permissionNeeded:'此服务限制发起权限。先在设置中保存管理员提供的访问令牌；加入邀请不需要另领令牌。',
 records:'协作记录',all:'全部',conversation:'有交流',invitation:'仅邀请',other:'其他',empty:'还没有协作记录',emptyHint:'发起一次协作，或在聊天中接收邀请后，记录会显示在这里。',emptyFilter:'这个分类下暂无记录。',localOnly:'仅显示本机记录，不代表对方当前在线。',untitled:'未记录目标',noTime:'时间未记录',last:'最近记录',messages:'{count} 条消息',recordedMessages:'本机已记录 {count} 条消息',noMessages:'暂无交流消息',noJoin:'尚无加入记录',noEnd:'未确认结束',
 recordUnknown:'状态待确认',recordUnreadable:'记录暂不可读',recordEnded:'已记录结束',recordPaused:'已记录暂停',invitationSent:'邀请已发出',peerReported:'对方报告完成',selfReported:'我方报告完成',recordOpen:'未记录结束',receiving:'正在接收消息',startingReception:'正在启动接收',stoppingReception:'正在停止接收',receptionStopped:'接收已停止',receptionSuspended:'接收遇到问题',unknownListener:'接收状态未确认',
 results:'最近结果',noResults:'还没有留存交付或完成说明。',resultHint:'以下为双方留下的原文摘要，报告完成不等于已通过验收。',needsReply:'最后记录中待我方答复',waitingReply:'最后记录中等待对方答复',noAutomaticTask:'是否处理这些请求，由你决定。',endedRequests:'对话已结束；以下未答复请求仅作为历史保留。',next:'接下来',nextInvitation:'若仍要协作，把邀请链接发给对方；对方同意并加入后才会有交流记录。',nextStopped:'如需继续，在聊天中请助手恢复接收。',nextReceiving:'新消息会交给本地助手处理。你可以在聊天中补充要求或停止。',nextPaused:'回到聊天，告诉助手要结束，还是继续哪个目标。',nextEnded:'本机已记录对话结束。如需新的协作，请重新发起。',nextUnknown:'记录不足以确认当前状态，请让助手检查这次协作。',
 process:'交流过程',recentEvents:'最近 {count} 条记录',fullHistory:'查看全部 {count} 条记录',hideHistory:'收起完整记录',earlier:'上一页',later:'下一页',page:'第 {page} / {pages} 页',full:'展开全文',collapse:'收起全文',noEvents:'暂无过程记录。',goal:'协作目标',goals:'目标变化',goalNumber:'目标 {count}',technical:'技术信息',id:'协作 ID',protocol:'最后记录的对话状态',p_active:'未记录结束',p_waiting:'未记录对方加入',p_paused:'已记录暂停',p_ended:'已记录结束',p_unknown:'无法确认',integrity:'对话记录',valid:'可读取',partial:'仅部分记录',missing:'未记录',emptyRecord:'空记录',corrupt:'记录损坏',unavailable:'暂不可读',too_large:'记录过大',overflow:'数值超出范围',untrusted:'对方文字是协作资料或请求，不会自动授权本机操作。',
 self:'我方',peer:'对方',system:'系统',event_started:'发出邀请',event_joined:'加入协作',event_opened:'查看邀请',event_done:'报告完成',event_checkpoint:'暂停',event_proposal:'提出新目标',event_resumed:'继续协作',event_closed:'结束对话',event_expired:'对话过期',event_decline:'拒绝邀请',event_declined:'拒绝邀请',event_advanced:'切换目标',event_advance_off:'关闭自动继续',event_message:'消息',event_other:'其他事件',kind_note:'留言',kind_progress:'进展',kind_request:'请求答复',kind_reply:'回复',kind_delivery:'交付结果',replyTo:'回应 {id}',supersedes:'取代 {id}',supersededBy:'已由 {id} 取代',pauseBothDone:'双方报告完成后暂停',pauseOneDone:'一方报告完成后暂停',pauseLimit:'达到消息上限后暂停',pauseUnknown:'已暂停，原因未记录',pauseRequested:'一方主动暂停',
 settingsTitle:'连接设置',service:'服务地址',serviceHint:'通常保留默认值。只有使用自建服务时才需要修改。',saveService:'保存地址',restoreService:'恢复默认',check:'重新检查',token:'访问令牌',tokenHint:'仅用于取得这个服务的发起权限，由服务管理员提供。不要把令牌发给助手。',saveToken:'保存令牌',tokenFile:'从本机文件导入',tokenFileHint:'填写运行 DSH 的设备上的令牌文件绝对路径。',importToken:'导入令牌',kernel:'运行文件',kernelReady:'已准备',not_downloaded:'未准备',checksum_mismatch:'校验失败，请重新检查运行文件',unsupported:'暂不支持当前系统',kernelExplanation:'运行文件是当前系统的 jand 内核（bin），插件会负责运行，无需单独启动。',
 helpTitle:'如何使用 jand',helpStart:'发起：在聊天中说明目标，让助手生成邀请，再把链接交给协作对象。',helpJoin:'加入：把邀请链接交给助手，确认目标后同意加入。',helpRecord:'记录：先看最近结果；需要追溯时再展开交流过程。消息往返不算新的协作，目标变化单独保留。',helpSafety:'默认使用 https://jand.zhou-wei.com 转发端到端加密消息。服务方无法读取正文，但可看到连接信息、消息大小和时间。邀请链接含加入权限，请只交给协作对象。',helpHost:'也可以自建 jand 中继，自行控制服务器、访问策略和保留方式，再到设置中修改服务地址。远程服务须使用 HTTPS。',
 metrics:'本机统计',recvReturns:'接收命令返回次数',emptyReturns:'其中无事件返回',cliOutputBytes:'命令输出字节',writtenBytes:'我方正文字节',receiveFailures:'接收失败次数',note:'命令返回不代表助手已处理，字节数不等于模型 token；这些统计不证明业务完成。',raw:'原始成本记录'
};
const en={...zh,language:'en-US',nav:'jand collaboration',title:'jand collaboration',help:'Help',settings:'Settings',refresh:'Refresh',refreshing:'Updating…',back:'Back to records',backHome:'Back',loading:'Loading…',failed:'Could not read records. Check the connection and retry.',refreshFailed:'Update failed. The previous snapshot is shown below.',saved:'Settings saved.',prepared:'Setup complete.',failedAction:'The operation did not finish. Check the connection and settings.',copyFailed:'Could not copy. Select the text below instead.',copied:'Copied. Paste it into your chat.',
 ready:'Plugin prepared',canJoin:'Ready to join',prepareTitle:'Prepare the plugin',prepareHint:'Download the runtime once. The plugin verifies and runs it automatically.',prepare:'Prepare plugin',preparing:'Preparing…',offline:'Unable to connect',offlineHint:'Check your network or the service address in Settings.',accessHint:'Starting a collaboration requires access.',access:'Set up access',quickStart:'Get started',quickHint:'Tell your assistant the goal, or paste an invitation into your chat.',start:'Start collaboration',join:'Join collaboration',startTitle:'Ask your assistant to start',startHint:'Return to your chat and describe what you want to work on together. Your assistant creates an invitation after you agree on the goal.',startExample:'I want to collaborate with an assistant on another device. Confirm the goal and responsibilities with me before creating an invitation.',joinTitle:'Ask your assistant to review an invitation',joinHint:'Paste the invitation into your chat. Ask your assistant to explain the goal and wait for your agreement before joining.',joinExample:'Review this collaboration invitation. Explain the goal and responsibilities, then wait for my agreement before joining.',copyExample:'Copy for assistant',backToChat:'Close Settings and paste the copied text into your current chat.',permissionNeeded:'This service restricts creation. Save the access token provided by its operator in Settings. Joining does not require a separate token.',
 records:'Collaboration records',all:'All',conversation:'With exchanges',invitation:'Invitations only',other:'Other',empty:'No collaborations yet',emptyHint:'Start a collaboration or accept an invitation in your chat to create a record.',emptyFilter:'No records in this category.',localOnly:'Local records only. They do not indicate whether the peer is online.',untitled:'Goal not recorded',noTime:'Time not recorded',last:'Last record',messages:'{count} messages',recordedMessages:'{count} locally recorded messages',noMessages:'No messages yet',noJoin:'No join recorded',noEnd:'End not confirmed',recordUnknown:'Status unconfirmed',recordUnreadable:'Record unavailable',recordEnded:'End recorded',recordPaused:'Pause recorded',invitationSent:'Invitation sent',peerReported:'Peer reported completion',selfReported:'You reported completion',recordOpen:'No end recorded',receiving:'Receiving messages',startingReception:'Starting reception',stoppingReception:'Stopping reception',receptionStopped:'Reception stopped',receptionSuspended:'Reception needs attention',unknownListener:'Reception unconfirmed',
 results:'Latest results',noResults:'No delivery or completion note is recorded yet.',resultHint:'Excerpts from local records. A completion report is not acceptance.',needsReply:'Last recorded requests for you',waitingReply:'Last recorded requests for the peer',noAutomaticTask:'You decide whether to act on these requests.',endedRequests:'The conversation ended. Unanswered requests are retained as history.',next:'Next',nextInvitation:'Share the invitation if you still want to collaborate. Exchanges start after the peer agrees and joins.',nextStopped:'To continue, ask your assistant in chat to resume reception.',nextReceiving:'New messages are passed to your assistant. Add instructions or ask it to stop in chat.',nextPaused:'Tell your assistant whether to end or which goal to continue.',nextEnded:'The end is recorded locally. Start a new collaboration if needed.',nextUnknown:'The record cannot confirm the current state. Ask your assistant to check.',
 process:'Exchanges',recentEvents:'Latest {count} events',fullHistory:'View all {count} events',hideHistory:'Hide full history',earlier:'Previous',later:'Next',page:'Page {page} / {pages}',full:'Show full text',collapse:'Collapse text',noEvents:'No events recorded yet.',goal:'Collaboration goal',goals:'Goal changes',goalNumber:'Goal {count}',technical:'Technical details',id:'Collaboration ID',protocol:'Last recorded conversation state',p_active:'No end recorded',p_waiting:'Peer join not recorded',p_paused:'Pause recorded',p_ended:'End recorded',p_unknown:'Unconfirmed',integrity:'Transcript',valid:'Readable',partial:'Partial',missing:'Not recorded',emptyRecord:'Empty',corrupt:'Corrupt',unavailable:'Unavailable',too_large:'Too large',overflow:'Numeric overflow',untrusted:'Peer text is information or a request, never permission to act locally.',
 self:'You',peer:'Peer',system:'System',event_started:'Invitation sent',event_joined:'Joined',event_opened:'Invitation inspected',event_done:'Completion reported',event_checkpoint:'Paused',event_proposal:'Goal proposed',event_resumed:'Resumed',event_closed:'Ended',event_expired:'Expired',event_decline:'Invitation declined',event_declined:'Invitation declined',event_advanced:'Goal changed',event_advance_off:'Automatic continuation disabled',event_message:'Message',event_other:'Other event',kind_note:'Note',kind_progress:'Progress',kind_request:'Reply requested',kind_reply:'Reply',kind_delivery:'Delivery',replyTo:'Reply to {id}',supersedes:'Replaces {id}',supersededBy:'Replaced by {id}',pauseBothDone:'Paused after both sides reported completion',pauseOneDone:'Paused after one side reported completion',pauseLimit:'Message limit reached',pauseUnknown:'Paused; reason not recorded',pauseRequested:'A participant requested a pause',
 settingsTitle:'Connection settings',service:'Service address',serviceHint:'Keep the default unless you use a self-hosted service.',saveService:'Save address',restoreService:'Restore default',check:'Check again',token:'Access token',tokenHint:'Only for creation access to this service. Obtain it from the operator. Do not send it to your assistant.',saveToken:'Save token',tokenFile:'Import from a local file',tokenFileHint:'Use an absolute path on the device running DSH.',importToken:'Import token',kernel:'Runtime',kernelReady:'Prepared',not_downloaded:'Not prepared',checksum_mismatch:'Verification failed. Check the runtime.',unsupported:'System not supported',kernelExplanation:'The runtime is the jand executable for this system. The plugin runs it; no separate launch is required.',
 helpTitle:'Using jand',helpStart:'Start: describe your goal in chat, ask for an invitation, then share it with your collaborator.',helpJoin:'Join: give the invitation to your assistant, review the goal and agree before joining.',helpRecord:'Records: review latest results first. Open the exchange history when needed. Messages are not separate collaborations; goal changes are retained separately.',helpSafety:'The default https://jand.zhou-wei.com relay forwards end-to-end encrypted messages. Its operator cannot read the content but can observe connection metadata, sizes and timing. Invitation links grant access; share them only with your collaborator.',helpHost:'You can host a jand relay to control its server, access and retention policies. Change its address in Settings. Remote services require HTTPS.',metrics:'Local measurements',recvReturns:'Receive command returns',emptyReturns:'Returns without events',cliOutputBytes:'Command output bytes',writtenBytes:'Own content bytes',receiveFailures:'Receive failures',note:'Command returns do not prove assistant handling. Bytes are not model tokens. Measurements do not certify task completion.',raw:'Raw cost records'};
Object.assign(zh,{settings:'管理',records:'协作记录',results:'交付与完成说明',process:'最近记录',self:'我方',peer:'对方',back:'返回列表',related:'消息关联',moreRequests:'更多请求见完整记录。',overview:'统计概览',recordCount:'记录总数',exchangeCount:'有交流',inviteCount:'仅邀请',messageCount:'消息总数',knownMessages:'已知消息数',unknownCounts:'{count} 条记录缺少完整统计',ownMessages:'我方消息',peerMessages:'对方消息',started:'开始时间',manage:'管理',closeManage:'收起',defaultService:'默认中继',customService:'自定义中继',kernelVersion:'内核',automaticKernel:'首次使用时自动准备',connectionOk:'连接正常',connectionUnknown:'连接未确认',tokenNeeded:'发起需要访问令牌，接收邀请无需另领。',tokenSaved:'已配置访问令牌，发起时校验。',tokenUnknown:'暂无法确认服务的访问要求。',autoHint:'通常无需配置。协作操作在聊天中完成。',selfHostGuide:'自建中继教程',securityGuide:'默认中继安全说明',releaseLink:'查看内核发行版本',kernelUpdateHint:'内核版本随插件更新，下载时校验文件。',securityTitle:'默认中继与安全',selfHostTitle:'自建中继',publicSafety:'默认中继转发端到端加密数据，无法读取正文。服务运营方仍可观察连接来源、时间和传输大小。',retentionSafety:'中继在内存中临时保存密文；过期或重启后不保证恢复。服务日志可包含会话短标识、大小和事件，反向代理也可能保留访问记录。',linkSafety:'邀请链接包含加入权限，请只交给协作对象。本机仍会保存协作记录。协议尚未经过独立安全审计。',accessSafety:'发起是否需要访问令牌，以服务实际策略为准。当前检测结果显示在配置区。',protocolDoc:'协议与安全边界（GitHub）',deployDoc:'完整部署教程（GitHub）',configDoc:'中继配置示例（GitHub）',hostIntro:'以下为 Linux 服务器搭建流程，具体命令见完整部署教程。',host1:'准备服务器、域名和 HTTPS 证书。下载对应 CPU 架构的 Linux 发行包，核对 SHA-256。',host2:'按教程安装 jand，用 Supervisor 管理服务，只监听本机 127.0.0.1:8787。',host3:'配置 Nginx 或 Caddy 的 HTTPS 反向代理。公网开放 HTTPS，不直接暴露 8787；检查请求缓冲和日志配置。',host4:'按需配置容量、超时和访问令牌。未限制访问时，知道地址的人可能占用中继资源。',host5:'从服务器外检查 /healthz，再按教程完成交接和对话测试。健康检查成功不代表协作已通过验收。',host6:'回到插件的“管理”，填写自己的 HTTPS 中继地址；若开启访问限制，再保存该服务的令牌。协作双方使用同一中继。',host7:'升级前结束现有会话、保留原二进制和配置，替换后重启并重新测试。重启会丢失内存中的数据。',requests:'未答复请求',statisticsScope:'仅统计本机留存记录。有交流指收到过对方消息；消息数不包含系统事件。',emptyHint:'协作操作在聊天中完成，记录会显示在这里。'});
Object.assign(en,{settings:'Manage',records:'Collaboration records',results:'Deliveries and completion notes',process:'Recent events',self:'You',peer:'Peer',back:'Back to list',related:'Message links',moreRequests:'More requests in full history.',overview:'Overview',recordCount:'Records',exchangeCount:'With exchanges',inviteCount:'Invitations only',messageCount:'Messages',knownMessages:'Known messages',unknownCounts:'{count} records have incomplete counts',ownMessages:'Sent',peerMessages:'Received',started:'Started',manage:'Manage',closeManage:'Collapse',defaultService:'Default relay',customService:'Custom relay',kernelVersion:'Runtime',automaticKernel:'Prepared on first use',connectionOk:'Connected',connectionUnknown:'Connection unconfirmed',tokenNeeded:'Creation requires an access token. Joining does not.',tokenSaved:'Token configured; checked on creation.',tokenUnknown:'Access policy could not be confirmed.',autoHint:'Usually no setup needed. Collaborate in chat.',selfHostGuide:'Self-hosting guide',securityGuide:'Default relay security',releaseLink:'Runtime releases',kernelUpdateHint:'Runtime versions follow plugin updates. Downloads are verified.',securityTitle:'Default relay and security',selfHostTitle:'Self-hosting',publicSafety:'The relay forwards end-to-end encrypted data. Its operator cannot read content, but can observe connection sources, timing and sizes.',retentionSafety:'Ciphertext is held temporarily in memory and may be lost on expiry or restart. Service logs can include short session identifiers, sizes and events; proxies may keep access logs.',linkSafety:'Invitations grant access. Share only with collaborators. Local records remain on your device. The protocol has not had an independent security audit.',accessSafety:'Creation access depends on the service policy shown in configuration.',protocolDoc:'Protocol and security (GitHub)',deployDoc:'Complete deployment guide (GitHub)',configDoc:'Relay configuration example (GitHub)',hostIntro:'Linux deployment outline. See the complete guide for commands.',host1:'Prepare a server, domain and HTTPS certificate. Download the matching Linux build and verify SHA-256.',host2:'Install jand and supervise it with Supervisor, listening only on 127.0.0.1:8787.',host3:'Configure Nginx or Caddy for HTTPS. Do not expose port 8787 publicly. Review buffering and logging.',host4:'Configure capacity, expiry and access tokens. Without access controls, others who know the address may use its resources.',host5:'Check /healthz externally, then run handoff and conversation tests from the guide. Health alone does not verify collaboration.',host6:'Under Manage, enter your HTTPS relay address and its token if required. Both participants use the same relay.',host7:'End sessions and keep the previous binary and configuration before upgrading. Restart and retest. Restart loses in-memory data.',requests:'Unanswered requests',statisticsScope:'Local records only. Exchanges require a peer message. Message totals exclude system events.',emptyHint:'Collaborate in chat. Records appear here.'});

Object.assign(zh,{brief:'协作摘要',briefGoal:'目标',briefProgress:'进展',briefSource:'以上摘自当前目标下双方最近的消息；完成声明不代表验收。',briefIncomplete:'记录不完整，以下摘要可能缺少内容。',chatHistory:'聊天记录',loadEarlier:'加载更早的 {count} 条记录',historyStart:'记录开始',eventDetails:'查看事件说明',conversationStats:'本次统计',pendingCount:'{count} 条未答复。最近一条：'});
Object.assign(en,{brief:'Summary',briefGoal:'Goal',briefProgress:'Progress',briefSource:'Excerpts from each side’s latest messages for the current goal. Completion reports do not imply acceptance.',briefIncomplete:'Records are incomplete; this summary may omit information.',chatHistory:'Chat history',loadEarlier:'Load {count} earlier records',historyStart:'Start of history',eventDetails:'Event details',conversationStats:'Conversation statistics',pendingCount:'{count} unanswered. Latest:'});

const css=`
.jand-page{color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:1.6;max-width:100%;padding-bottom:20px;overflow-wrap:anywhere}
.jand-page *{box-sizing:border-box}.jand-page h2{font-family:inherit;font-weight:600;font-size:20px;line-height:1.4;margin:0}.jand-page h3{font-size:15px;line-height:1.5;font-weight:600;margin:0 0 10px}.jand-page p{margin:6px 0 12px}.jand-page button,.jand-page input{font:inherit;color:inherit}.jand-page button{min-height:36px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);cursor:pointer}.jand-page button:hover{background:var(--dsw-alias-interactive-bg-hover)}.jand-page button:disabled{opacity:.55;cursor:default}.jand-page button.jand-primary{background:var(--dsw-alias-state-business-primary,#3565df);color:var(--dsw-alias-label-on-color,#fff);border-color:transparent}.jand-page :is(button,input,summary):focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3565df));outline-offset:3px}.jand-page input{width:100%;min-height:40px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px}.jand-page summary{cursor:pointer;min-height:36px;padding:8px 0}.jand-page pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;margin:8px 0}.jand-muted{font-size:12px;color:var(--dsw-alias-label-secondary)}.jand-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.jand-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.jand-section{padding:20px 0;border-top:1px solid var(--dsw-alias-border-l2)}.jand-readiness{display:flex;align-items:center;justify-content:space-between;gap:16px}.jand-readiness p{margin:4px 0}.jand-notice{margin:8px 0}.jand-error{border-inline-start:3px solid currentColor;padding-inline-start:10px}.jand-filters{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.jand-filters button[aria-pressed=true]{font-weight:600;border-color:currentColor}.jand-history{list-style:none;padding:0;margin:0}.jand-page .jand-history-button{display:grid;grid-template-columns:minmax(0,1fr) auto 16px;gap:12px;align-items:center;width:100%;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:0;padding:12px 4px;background:transparent;text-align:start}.jand-history-main{min-width:0}.jand-history-title{font-size:14px;line-height:1.5;font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.jand-history-meta{display:block;margin-top:4px}.jand-history time{font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}.jand-chevron{width:16px;height:16px;flex-shrink:0}.jand-excerpt{padding:12px;margin:8px 0;background:var(--dsw-alias-bg-layer-2);border-radius:8px;min-width:0}.jand-excerpt p{white-space:pre-wrap;margin:6px 0}.jand-excerpt-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px}.jand-excerpt-head strong{font-weight:600}.jand-page .jand-text-button{padding:2px 4px;border:0;background:transparent;min-height:30px;font-size:12px;text-decoration:underline;text-underline-offset:3px}.jand-event-list{list-style:none;padding:0;margin:0}.jand-event-list>li{padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.jand-event-list .jand-excerpt{background:transparent;padding:0;margin:0}.jand-field{display:grid;gap:6px;margin:16px 0}.jand-field label{font-weight:600}.jand-back{margin-bottom:16px}.jand-goal{margin:12px 0}.jand-technical{font-size:12px}.jand-technical dt{color:var(--dsw-alias-label-secondary)}.jand-technical dd{margin:0 0 12px;overflow-wrap:anywhere}.jand-raw{font-family:monospace!important;max-height:260px;overflow:auto}.jand-page [role=status]:empty{display:none}.jand-page .jand-example{padding:12px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;white-space:pre-wrap}.jand-pagination{justify-content:space-between;margin:12px 0}.jand-empty{padding:24px 0}.jand-footer{margin-top:18px}
@media(max-width:480px){.jand-header{align-items:flex-start}.jand-header .jand-row{gap:4px}.jand-header button{padding-inline:8px}.jand-history-button{grid-template-columns:minmax(0,1fr) 16px!important;gap:6px!important}.jand-history time{grid-column:1;grid-row:2}.jand-history .jand-chevron{grid-column:2;grid-row:1/3}.jand-readiness{align-items:flex-start;flex-direction:column}.jand-page h2{font-size:18px}.jand-row>button{max-width:100%}}
`;
const dashboardCss=`
.jand-config{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:16px;margin-bottom:24px}.jand-config-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.jand-config p{margin:4px 0}.jand-links{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px}.jand-overview,.jand-detail-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:12px 0 20px}.jand-detail-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.jand-stat dt{font-size:12px;color:var(--dsw-alias-label-secondary)}.jand-stat dd{font-size:24px;font-variant-numeric:tabular-nums;margin:4px 0}.jand-docs li{margin:14px 0}.jand-docs a,.jand-config a{color:inherit;text-decoration:underline}.jand-history-toggle{margin-top:12px}.jand-detail-meta{margin:12px 0!important}@media(max-width:480px){.jand-overview{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

const chatCss=`
.jand-brief{padding:16px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin:20px 0 28px;background:var(--dsw-alias-bg-layer-2)}.jand-brief dl{margin:0}.jand-brief dt{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:12px}.jand-brief dd{margin:4px 0 12px;line-height:1.65}.jand-brief p:last-child{margin-bottom:0}.jand-chat-log{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:18px}.jand-chat-message{width:85%;max-width:640px;min-width:0}.jand-chat-self{align-self:flex-end}.jand-chat-peer{align-self:flex-start}.jand-chat-message .jand-excerpt{margin:0;padding:12px 14px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}.jand-chat-self .jand-excerpt{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3565df) 8%,var(--dsw-alias-bg-layer-1,#fff));border-end-end-radius:3px}.jand-chat-peer .jand-excerpt{border-end-start-radius:3px}.jand-chat-self .jand-excerpt-head{flex-direction:row-reverse}.jand-chat-system{text-align:center;align-self:center;color:var(--dsw-alias-label-secondary);font-size:12px;max-width:90%;padding:4px 0}.jand-chat-system time{display:block;font-size:11px}.jand-chat-system pre{text-align:start}.jand-chat-start{text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}.jand-page .jand-load-earlier{display:block;margin:12px auto 22px;background:transparent}.jand-chat-section{padding-bottom:28px}.jand-chat-section h3{margin:0}.jand-chat-section>.jand-config-head{margin-bottom:18px}@media(max-width:480px){.jand-chat-message{width:94%}.jand-brief{padding:12px}}
`;

const h=React.createElement;
const NS='jand';
const PUBLIC_RELAY='https://jand.zhou-wei.com';
const counted=(t,key,count)=>t(key).replace('{count}',String(count));
const when=(value,t)=>value?new Intl.DateTimeFormat(t('language'),{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):t('noTime');
const button=(label,onClick,props={})=>h('button',{type:'button',onClick,...props},label);
function Chevron(){return h('svg',{className:'jand-chevron',viewBox:'0 0 20 20',fill:'none','aria-hidden':true},h('path',{d:'m7 4 6 6-6 6',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'}));}
const roleLabel=(line,role,t)=>t(line.from===role?'self':['host','guest'].includes(line.from)?'peer':'system');
const eventLabel=(line,t)=>t(line.kind==='message'&&['note','progress','request','reply','delivery'].includes(line.type)?'kind_'+line.type:['started','joined','opened','done','checkpoint','proposal','resumed','closed','expired','decline','declined','advanced','advance_off','message'].includes(line.kind)?'event_'+line.kind:'event_other');
function Excerpt({line,role,t,replacements,compact=false}) {
  const [expanded,setExpanded]=React.useState(false);
  const body=line.kind==='checkpoint'?[t(checkpointReason(line)),line.from==='relay'?'':line.text].filter(Boolean).join('\n'):line.kind==='expired'?'':line.text??'';
  const limit=compact?100:160,preview=shortText(body,limit),long=body.length>limit||body.split('\n').length>3;
  return h('div',{className:'jand-excerpt'},
    h('div',{className:'jand-excerpt-head'},h('strong',null,roleLabel(line,role,t)+' · '+eventLabel(line,t)),h('time',{dateTime:line.time,className:'jand-muted'},when(line.time,t))),
    body?h(expanded?'pre':'p',{className:'jand-excerpt-body'},expanded?body:preview):null,
    long?button(t(expanded?'collapse':'full'),()=>setExpanded(!expanded),{className:'jand-text-button','aria-expanded':expanded}):null,
    line.reply_to||line.supersedes||replacements?.has(line.id)?h('details',{className:'jand-muted'},h('summary',null,t('related')),line.reply_to?t('replyTo').replace('{id}',line.reply_to)+' ':null,line.supersedes?t('supersedes').replace('{id}',line.supersedes)+' ':null,replacements?.has(line.id)?t('supersededBy').replace('{id}',replacements.get(line.id)):null):null);
}
function ChatMessage({line,detail,t,replacements}) {
  const participant=['host','guest'].includes(line.from);
  const spoken=participant&&['message','done','proposal'].includes(line.kind);
  return h('li',{className:spoken?'jand-chat-message '+(line.from===detail.role?'jand-chat-self':'jand-chat-peer'):'jand-chat-system'},
    spoken?h(Excerpt,{line,role:detail.role,t,replacements}):h(React.Fragment,null,
      h('span',null,line.kind==='checkpoint'?t(checkpointReason(line)):eventLabel(line,t)),
      h('time',{dateTime:line.time},when(line.time,t)),
      line.text?h('details',null,h('summary',null,t('eventDetails')),h('pre',null,line.text)):null));
}
function Transcript({detail,t,replacements}) {
  const [count,setCount]=React.useState(10);
  const start=Math.max(0,detail.timeline.length-count);
  return h('div',{className:'jand-transcript'},
    start?button(counted(t,'loadEarlier',Math.min(10,start)),()=>setCount(count+10),{className:'jand-load-earlier'}):h('p',{className:'jand-chat-start'},t('historyStart')),
    detail.timeline.length?h('ol',{className:'jand-chat-log','aria-label':t('chatHistory')},detail.timeline.slice(start).map((line,i)=>h(ChatMessage,{key:start+i,line,detail,t,replacements}))):h('p',{className:'jand-muted'},t('noEvents')));
}
function Brief({detail,summary,t}) {
  const brief=conversationBrief(detail);
  const requests=[...summary.incomingRequests,...summary.outgoingRequests];
  return h('section',{className:'jand-brief','aria-label':t('brief')},h('h3',null,t('brief')),
    !brief.known?h('p',{className:'jand-error'},t('briefIncomplete')):null,
    h('dl',null,h('dt',null,t('briefGoal')),h('dd',null,shortText(brief.goal,150)||t('untitled')),
      ...brief.updates.flatMap((line,i)=>[h('dt',{key:'label'+i},roleLabel(line,detail.role,t)+' · '+eventLabel(line,t)),h('dd',{key:'text'+i},shortText(line.text,180))]),
      !brief.updates.length?h(React.Fragment,null,h('dt',null,t('briefProgress')),h('dd',null,t(summary.category==='invitation'?'noJoin':'noResults'))):null,
      requests.length?h(React.Fragment,null,h('dt',null,t('requests')),h('dd',null,counted(t,'pendingCount',requests.length)+' '+shortText(requests.at(-1).text,120))):null),
    h('p',{className:'jand-muted'},t('briefSource')));
}
function RecordDetail({detail,t}) {
  const summary=recordSummary(detail);
  const replacements=new Map(detail.timeline.filter(l=>l.id&&l.supersedes).map(l=>[l.supersedes,l.id]));
  const stats=detail.statistics;
  return h('article',{className:'jand-detail'},
    h('h2',null,summary.title||t('untitled')),
    h('p',{className:'jand-muted jand-detail-meta'},t(summary.state)+' · '+t('last')+' '+when(summary.last,t)),
    h(Brief,{detail,summary,t}),
    h('section',{className:'jand-chat-section'},h('div',{className:'jand-config-head'},h('h3',null,t('chatHistory')),h('span',{className:'jand-muted'},summary.messages==null?t('missing'):counted(t,'messages',summary.messages))),h(Transcript,{detail,t,replacements})),
    h('details',{className:'jand-section'},h('summary',null,t('conversationStats')),h(DetailStats,{detail,summary,t})),
    h('details',{className:'jand-section jand-goals'},h('summary',null,t(detail.segments.length>1?'goals':'goal')),
      detail.segments.length?detail.segments.map(segment=>h('div',{key:segment.number,className:'jand-goal'},detail.segments.length>1?h('strong',null,counted(t,'goalNumber',segment.number)):null,h('pre',null,segment.goal||t('untitled')))):h('pre',null,detail.goal||t('untitled'))),
    h('details',{className:'jand-section jand-technical'},h('summary',null,t('technical')),
      h('dl',null,h('dt',null,t('id')),h('dd',null,detail.chat),h('dt',null,t('protocol')),h('dd',null,t('p_'+(['active','waiting','paused','ended'].includes(detail.status)?detail.status:'unknown'))),h('dt',null,t('integrity')),h('dd',null,t(stats.integrity.transcript==='empty'?'emptyRecord':stats.integrity.transcript))),
      h('p',null,t('untrusted')),
      h('details',null,h('summary',null,t('metrics')),h('dl',{className:'jand-metrics'},[['recvReturns',stats.jand?.recvReturns],['emptyReturns',stats.jand?.emptyReturns],['cliOutputBytes',stats.jand?.cliOutputBytes],['writtenBytes',stats.jand?.writtenBytes],['receiveFailures',stats.plugin?.receiveFailures]].map(([key,value])=>h('div',{key},h('dt',null,t(key)),h('dd',null,value==null?t('missing'):new Intl.NumberFormat(t('language')).format(value))))),h('p',null,t('note'))),
      h('details',null,h('summary',null,t('raw')),h('pre',{className:'jand-raw'},JSON.stringify(stats.costRecords,null,2)))));
}
function RecordList({items,t,onSelect}) {
  const [filter,setFilter]=React.useState('all');
  const counts={all:items.length,conversation:items.filter(x=>x.category==='conversation').length,invitation:items.filter(x=>x.category==='invitation').length,other:items.filter(x=>x.category==='other').length};
  const visible=items.filter(x=>filter==='all'||x.category===filter);
  return h('section',{className:'jand-section jand-records'},h('h3',null,t('records')),
    items.length?h('div',{className:'jand-filters','aria-label':t('records')},['all','conversation','invitation',...(counts.other?['other']:[])].map(key=>button(t(key)+' '+counts[key],()=>setFilter(key),{key,'aria-pressed':filter===key}))):null,
    !items.length?h('div',{className:'jand-empty'},h('p',null,t('empty')),h('p',{className:'jand-muted'},t('emptyHint'))):!visible.length?h('p',{className:'jand-muted'},t('emptyFilter')):
      h('ul',{className:'jand-history'},visible.map(item=>h('li',{key:item.chat},button(h(React.Fragment,null,
        h('span',{className:'jand-history-main'},h('span',{className:'jand-history-title'},item.title||t('untitled')),h('span',{className:'jand-muted jand-history-meta'},t(item.state)+(['peerReported','selfReported'].includes(item.state)?' · '+t('noEnd'):'')+' · '+(item.category==='invitation'?t('noJoin'):item.messages==null?t('missing'):counted(t,'messages',item.messages)))),
        h('time',{dateTime:item.last??undefined,className:'jand-muted'},when(item.last,t)),h(Chevron)),()=>onSelect(item.chat),{className:'jand-history-button'})))),
    h('p',{className:'jand-muted jand-footer'},t('localOnly')));
}
function ConnectionSettings({state,relay,setRelay,token,setToken,tokenFile,setTokenFile,formId,t,busy,act,configure,prepare,saveToken,refresh}) {
  const requiresAccess=state.health.state==='online'&&state.health.access===true;
  return h('section',null,h('h2',null,t('settingsTitle')),
    requiresAccess?h('div',{className:'jand-section'},h('div',{className:'jand-field'},h('label',{htmlFor:formId+'token'},t('token')),h('input',{id:formId+'token',type:'password',value:token,autoComplete:'off',spellCheck:false,onChange:e=>setToken(e.target.value),'aria-describedby':formId+'token-hint'}),h('span',{id:formId+'token-hint',className:'jand-muted'},t('tokenHint'))),button(t('saveToken'),()=>act('token',async()=>{const value=token;setToken('');await saveToken({value});}),{disabled:!!busy||!token.trim(),className:'jand-primary'}),
      h('details',null,h('summary',null,t('tokenFile')),h('label',{className:'jand-field'},t('tokenFileHint'),h('input',{value:tokenFile,onChange:e=>setTokenFile(e.target.value)})),button(t('importToken'),()=>act('token',()=>configure({token_file:tokenFile})),{disabled:!!busy||!tokenFile.trim()}))):null,
    h('div',{className:'jand-section'},h('div',{className:'jand-field'},h('label',{htmlFor:formId+'relay'},t('service')),h('input',{id:formId+'relay',type:'url',value:relay,autoComplete:'off',onChange:e=>setRelay(e.target.value),'aria-describedby':formId+'relay-hint'}),h('span',{id:formId+'relay-hint',className:'jand-muted'},t('serviceHint'))),
      h('div',{className:'jand-row'},button(t('saveService'),()=>act('relay',()=>configure({relay})),{disabled:!!busy}),state.relay!==PUBLIC_RELAY?button(t('restoreService'),()=>act('relay',()=>configure({relay:PUBLIC_RELAY})),{disabled:!!busy}):null,button(t('check'),refresh,{disabled:!!busy}))),
    h('details',{className:'jand-section'},h('summary',null,t('kernel')),h('p',null,t('kernelExplanation')),h('p',{className:'jand-muted'},t('kernelUpdateHint')),docLink('https://github.com/jaredchao/jand/releases',t('releaseLink')),h('p',{className:'jand-muted'},state.kernel.version+' · '+state.kernel.platform+' · '+t(state.kernel.state==='ready'?'kernelReady':state.kernel.state)),state.kernel.state!=='ready'?button(t(busy==='prepare'?'preparing':'prepare'),()=>act('prepare',()=>prepare({})),{disabled:!!busy||state.kernel.state==='unsupported'}):null));
}

const docLink=(href,label)=>h('a',{href,target:'_blank',rel:'noopener noreferrer'},label);
function Stat({label,value}){return h('div',{className:'jand-stat'},h('dt',null,label),h('dd',null,value==null?'—':value));}
function Overview({items,t}){const total=historyTotals(items);return h('section',null,h('h3',null,t('overview')),h('dl',{className:'jand-overview'},[['recordCount',total.records],['exchangeCount',total.conversations],['inviteCount',total.invitations],[total.unknown?'knownMessages':'messageCount',total.messages]].map(([key,value])=>h(Stat,{key,label:t(key),value}))),total.unknown?h('p',{className:'jand-muted'},counted(t,'unknownCounts',total.unknown)):null,h('p',{className:'jand-muted'},t('statisticsScope')));}
function DetailStats({detail,summary,t}){const messages=detail.timeline.filter(x=>x.kind==='message');return h(React.Fragment,null,h('dl',{className:'jand-detail-stats'},[['messageCount',summary.messages],['ownMessages',summary.known?messages.filter(x=>x.from===detail.role).length:null],['peerMessages',summary.known?messages.filter(x=>['host','guest'].includes(x.from)&&x.from!==detail.role).length:null]].map(([key,value])=>h(Stat,{key,label:t(key),value}))),h('p',{className:'jand-muted'},t('started')+' '+when(summary.started,t)));}
function Guide({kind,t}){const root='https://github.com/jaredchao/jand/blob/main/';return h('section',{className:'jand-docs'},h('h2',null,t(kind==='security'?'securityTitle':'selfHostTitle')),kind==='security'?h(React.Fragment,null,...['publicSafety','retentionSafety','linkSafety','accessSafety'].map(key=>h('p',{key},t(key))),docLink(root+'docs/HTTP_DESIGN.md',t('protocolDoc'))):h(React.Fragment,null,h('p',null,t('hostIntro')),h('p',null,docLink(root+'deploy/INSTALL.md',t('deployDoc'))),h('ol',null,...Array.from({length:7},(_,i)=>h('li',{key:i},t('host'+(i+1))))),h('div',{className:'jand-links'},docLink(root+'deploy/relay.json.example',t('configDoc')),docLink('https://github.com/jaredchao/jand/releases',t('releaseLink')))));}

function Panel({t,read,configure,prepare,saveToken}) {
  const [view,setView]=React.useState(null),[chat,setChat]=React.useState(''),[page,setPage]=React.useState('home'),[busy,setBusy]=React.useState(''),[notice,setNotice]=React.useState(''),[error,setError]=React.useState(''),[relay,setRelay]=React.useState(''),[token,setToken]=React.useState(''),[tokenFile,setTokenFile]=React.useState(''),[loading,setLoading]=React.useState(true);
  const generation=React.useRef(0),previous=React.useRef(null),formId=React.useId();
  const load=React.useCallback(async(selected='')=>{
    const request=++generation.current;setError('');setLoading(true);
    try{const value=await read(selected?{chat:selected}:{});if(request!==generation.current)return;previous.current=value;setView(value);setRelay(value.status.relay);}
    catch{if(request===generation.current)setError(t(previous.current?'refreshFailed':'failed'));}
    finally{if(request===generation.current)setLoading(false);}
  },[read,t]);
  React.useEffect(()=>{void load(chat);return()=>{generation.current++;};},[chat,load]);
  const act=async(name,action)=>{
    setBusy(name);setError('');setNotice('');
    try{await action();setNotice(t(name==='prepare'?'prepared':'saved'));await load(chat);}catch{setError(t('failedAction'));}finally{setBusy('');}
  };
  const navigate=next=>{setNotice('');setError('');setPage(next);setChat('');setToken('');};
  const state=view?.status;
  const home=()=>navigate('home');
  return h('section',{className:'jand-page','aria-busy':!!busy||loading},h('style',null,css+dashboardCss+chatCss),
    h('header',{className:'jand-header'},h('h2',null,t('title')),button(t(loading?'refreshing':'refresh'),()=>load(chat),{disabled:!!busy||loading})),
    h('div',{className:'jand-notice',role:'status','aria-live':'polite'},notice),error?h('p',{role:'alert',className:'jand-error'},error):null,
    !state?(loading?h('p',{role:'status'},t('loading')):null):chat?h(React.Fragment,null,button(t('back'),home,{className:'jand-back'}),loading?h('p',{role:'status'},t('loading')):view.detail?.chat===chat?h(RecordDetail,{key:chat,detail:view.detail,t}):null):
    ['security','selfhost'].includes(page)?h(React.Fragment,null,button(t('back'),home,{className:'jand-back'}),h(Guide,{kind:page,t})):
    h(React.Fragment,null,
      h('section',{className:'jand-config'},h('div',{className:'jand-config-head'},h('strong',null,t(state.relay===PUBLIC_RELAY?'defaultService':'customService')+' · '+t(state.health.state==='online'?'connectionOk':'connectionUnknown')),button(t(page==='settings'?'closeManage':'manage'),()=>navigate(page==='settings'?'home':'settings'),{'aria-expanded':page==='settings'})),
        h('p',{className:'jand-muted'},t('kernelVersion')+' '+state.kernel.version+' · '+t(state.kernel.state==='ready'?'kernelReady':state.kernel.state==='not_downloaded'?'automaticKernel':state.kernel.state)),
        h('p',{className:'jand-muted'},t('autoHint')),
        state.health.state!=='online'?h('p',null,t('tokenUnknown')):state.health.access===true?h('p',null,t(state.creation==='token_required'?'tokenNeeded':'tokenSaved')):null,
        h('div',{className:'jand-links'},button(t('securityGuide'),()=>navigate('security'),{className:'jand-text-button'}),button(t('selfHostGuide'),()=>navigate('selfhost'),{className:'jand-text-button'})),
        page==='settings'?h(ConnectionSettings,{state,relay,setRelay,token,setToken,tokenFile,setTokenFile,formId,t,busy,act,configure,prepare,saveToken,refresh:()=>load('')}):null),
      h(Overview,{items:view.conversations,t}),h(RecordList,{items:view.conversations,t,onSelect:id=>{setNotice('');setPage('home');setChat(id);}})));
}
return {inject:['slots','locale','remote'],async apply(ctx){
  ctx.locale.register(NS,{zh,en});
  await ctx.remote.$mount(clientContribution(z));
  ctx.inject(['remote.jandPanel'],panelCtx=>{
    const call=name=>async request=>{const result=await panelCtx.remote.jandPanel[name](request);if(!result.ok)throw result.error;return result.value;};
    const callbacks={read:call('read'),configure:call('configure'),prepare:call('prepare'),saveToken:call('saveToken')};
    panelCtx.slots.inject('settings.section',()=>panelCtx.slots.register({name:'settings.section',id:'jand',order:30,label:()=>panelCtx.locale.bind(NS)('nav'),locale:NS,inject:()=>callbacks},Panel));
  });
}};

}});
