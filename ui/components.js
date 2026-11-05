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
const KERNEL_ERROR_CODES={JAND_KERNEL_UNSUPPORTED:'kernelErrUnsupported',JAND_KERNEL_OFFLINE:'kernelErrOffline',JAND_KERNEL_NETWORK:'kernelErrNetwork',JAND_KERNEL_TLS:'kernelErrTls',JAND_KERNEL_TIMEOUT:'kernelErrTimeout',JAND_KERNEL_HTTP:'kernelErrHttp',JAND_KERNEL_REDIRECT:'kernelErrRedirect',JAND_KERNEL_SIZE:'kernelErrSize',JAND_KERNEL_ARCHIVE:'kernelErrArchive',JAND_KERNEL_BINARY:'kernelErrBinary',JAND_KERNEL_CACHED:'kernelErrCached',JAND_KERNEL_WRITE:'kernelErrWrite',JAND_KERNEL_MANIFEST:'kernelErrManifest',JAND_KERNEL_OVERRIDE:'kernelErrOverride',JAND_KERNEL_INSECURE:'kernelErrInsecure',JAND_KERNEL_IMPORT:'kernelErrImport'};
function kernelErrorText(t,cause){
  const raw=String(cause?.message??cause??'');
  const code=(raw.match(/\bJAND_KERNEL_[A-Z_]+\b/)||[])[0];
  const key=code&&KERNEL_ERROR_CODES[code];
  return key&&t(key)?t(key)+' ('+code+')':t('failedAction');
}
const sizeText=bytes=>bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(bytes/1024))} KB`;
function prepareText(t,preparation) {
  const stage=t('stage_'+preparation.stage);
  const name=stage&&stage!=='stage_'+preparation.stage?stage:preparation.stage;
  const done=sizeText(preparation.received??0);
  return preparation.total?t('prepareProgress').replace('{stage}',name).replace('{done}',done).replace('{total}',sizeText(preparation.total)):t('prepareProgressUnknown').replace('{stage}',name).replace('{done}',done);
}
function ConnectionSettings({state,relay,setRelay,token,setToken,tokenFile,setTokenFile,importPath,setImportPath,formId,t,busy,act,configure,prepare,importKernel,saveToken,refresh}) {
  const requiresAccess=state.health.state==='online'&&state.health.access===true;
  return h('section',null,h('h2',null,t('settingsTitle')),state.harness?h('p',{className:'jand-muted'},(state.harness.version?t('harnessNoteVersion').replace('{version}',state.harness.version):t('harnessNote')).replace('{tested}',state.harness.tested??'')):null,
    state.kernel.state==='unsupported'?h('div',{className:'jand-section jand-error',role:'alert'},h('p',null,h('strong',null,t('unsupportedTitle'))),h('p',null,t('unsupportedBanner')),state.kernel.published?.length?h('p',{className:'jand-muted'},t('unsupportedPublished')+' '+(state.kernel.published||[]).join(' · ')):null):null,
    requiresAccess?h('div',{className:'jand-section'},h('div',{className:'jand-field'},h('label',{htmlFor:formId+'token'},t('token')),h('input',{id:formId+'token',type:'password',value:token,autoComplete:'off',spellCheck:false,onChange:e=>setToken(e.target.value),'aria-describedby':formId+'token-hint'}),h('span',{id:formId+'token-hint',className:'jand-muted'},t('tokenHint'))),button(t('saveToken'),()=>act('token',async()=>{const value=token;setToken('');await saveToken({value});}),{disabled:!!busy||!token.trim(),className:'jand-primary'}),
      h('details',null,h('summary',null,t('tokenFile')),h('label',{className:'jand-field'},t('tokenFileHint'),h('input',{value:tokenFile,onChange:e=>setTokenFile(e.target.value)})),button(t('importToken'),()=>act('token',()=>configure({token_file:tokenFile})),{disabled:!!busy||!tokenFile.trim()}))):null,
    h('div',{className:'jand-section'},h('div',{className:'jand-field'},h('label',{htmlFor:formId+'relay'},t('service')),h('input',{id:formId+'relay',type:'url',value:relay,autoComplete:'off',onChange:e=>setRelay(e.target.value),'aria-describedby':formId+'relay-hint'}),h('span',{id:formId+'relay-hint',className:'jand-muted'},t('serviceHint'))),
      h('div',{className:'jand-row'},button(t('saveService'),()=>act('relay',()=>configure({relay})),{disabled:!!busy}),state.relay!==PUBLIC_RELAY?button(t('restoreService'),()=>act('relay',()=>configure({relay:PUBLIC_RELAY})),{disabled:!!busy}):null,button(t('check'),refresh,{disabled:!!busy})),
      state.relay===PUBLIC_RELAY?h('p',{className:'jand-muted'},t('defaultRelayNote').replace('{relay}',state.relay)):null),
    h('details',{className:'jand-section'},h('summary',null,t('kernel')),h('p',null,t('kernelExplanation')),h('p',{className:'jand-muted'},t('kernelUpdateHint')),h('p',{className:'jand-muted'},t(state.kernel.signed?'kernelSignedHint':'kernelUnsignedHint')),docLink('https://github.com/jaredchao/jand/releases',t('releaseLink')),h('p',{className:'jand-muted'},state.kernel.version+' · '+state.kernel.platform+' · '+t(state.kernel.state==='ready'?'kernelReady':state.kernel.state)),state.kernel.sources?.length?h('p',{className:'jand-muted'},t('kernelSources').replace('{hosts}',state.kernel.sources.join(' · '))):null,state.kernel.origin?.host?h('p',{className:'jand-muted'},t(state.kernel.origin.source==='backup'?'kernelOriginBackup':'kernelOriginPrimary').replace('{host}',state.kernel.origin.host)):null,state.kernel.state!=='ready'?button(t(busy==='prepare'?'preparing':'prepare'),()=>act('prepare',()=>prepare({})),{disabled:!!busy||state.kernel.state==='unsupported'}):null,h('details',{className:'jand-import'},h('summary',null,t('importFile')),h('p',{className:'jand-muted'},t('importFileHint')),h('label',{className:'jand-field'},t('importFilePath'),h('input',{value:importPath,autoComplete:'off',spellCheck:false,placeholder:t('importFilePlaceholder'),onChange:e=>setImportPath(e.target.value)})),button(t(busy==='importKernel'?'importing':'importFileAction'),()=>act('importKernel',()=>importKernel({path:importPath})),{disabled:!!busy||!importPath.trim()||state.kernel.state==='unsupported'})),state.preparation?h('p',{className:'jand-muted',role:'status'},prepareText(t,state.preparation)):null));
}

const docLink=(href,label)=>h('a',{href,target:'_blank',rel:'noopener noreferrer'},label);
function Stat({label,value}){return h('div',{className:'jand-stat'},h('dt',null,label),h('dd',null,value==null?'—':value));}
function Overview({items,t}){const total=historyTotals(items);return h('section',null,h('h3',null,t('overview')),h('dl',{className:'jand-overview'},[['recordCount',total.records],['exchangeCount',total.conversations],['inviteCount',total.invitations],[total.unknown?'knownMessages':'messageCount',total.messages]].map(([key,value])=>h(Stat,{key,label:t(key),value}))),total.unknown?h('p',{className:'jand-muted'},counted(t,'unknownCounts',total.unknown)):null,h('p',{className:'jand-muted'},t('statisticsScope')));}
function DetailStats({detail,summary,t}){const messages=detail.timeline.filter(x=>x.kind==='message');return h(React.Fragment,null,h('dl',{className:'jand-detail-stats'},[['messageCount',summary.messages],['ownMessages',summary.known?messages.filter(x=>x.from===detail.role).length:null],['peerMessages',summary.known?messages.filter(x=>['host','guest'].includes(x.from)&&x.from!==detail.role).length:null]].map(([key,value])=>h(Stat,{key,label:t(key),value}))),h('p',{className:'jand-muted'},t('started')+' '+when(summary.started,t)));}
function Guide({kind,t}){const root='https://github.com/jaredchao/jand/blob/main/';return h('section',{className:'jand-docs'},h('h2',null,t(kind==='security'?'securityTitle':'selfHostTitle')),kind==='security'?h(React.Fragment,null,...['publicSafety','retentionSafety','linkSafety','accessSafety'].map(key=>h('p',{key},t(key))),docLink(root+'docs/HTTP_DESIGN.md',t('protocolDoc'))):h(React.Fragment,null,h('p',null,t('hostIntro')),h('p',null,docLink(root+'deploy/INSTALL.md',t('deployDoc'))),h('ol',null,...Array.from({length:7},(_,i)=>h('li',{key:i},t('host'+(i+1))))),h('div',{className:'jand-links'},docLink(root+'deploy/relay.json.example',t('configDoc')),docLink('https://github.com/jaredchao/jand/releases',t('releaseLink')))));}
