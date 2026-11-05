function Panel({t,read,configure,prepare,importKernel,saveToken}) {
  const [view,setView]=React.useState(null),[chat,setChat]=React.useState(''),[page,setPage]=React.useState('home'),[busy,setBusy]=React.useState(''),[notice,setNotice]=React.useState(''),[error,setError]=React.useState(''),[relay,setRelay]=React.useState(''),[token,setToken]=React.useState(''),[tokenFile,setTokenFile]=React.useState(''),[importPath,setImportPath]=React.useState(''),[loading,setLoading]=React.useState(true);
  const generation=React.useRef(0),previous=React.useRef(null),formId=React.useId();
  const load=React.useCallback(async(selected='')=>{
    const request=++generation.current;setError('');setLoading(true);
    try{
      const value=await read({mode:'local',...selected?{chat:selected}:{}});
      if(request!==generation.current)return;
      const prior=previous.current?.status;
      const status=prior?.relay===value.status.relay&&selected?prior:value.status;
      previous.current={...previous.current,...value,status};
      setView(previous.current);setRelay(status.relay);
    }
    catch{if(request===generation.current)setError(t(previous.current?'refreshFailed':'failed'));return;}
    finally{if(request===generation.current)setLoading(false);}
    if(!selected){
      try{
        const {status}=await read({mode:'connection'});
        if(request!==generation.current)return;
        previous.current={...previous.current,status};
        setView(previous.current);
      }catch{/* Local history remains usable while connection status is unavailable. */}
    }
  },[read,t]);
  React.useEffect(()=>{void load(chat);return()=>{generation.current++;};},[chat,load]);  // While the runtime downloads, keep the progress line current without
  // replacing the record list with a loading state.
  const refreshStatus=React.useCallback(async()=>{
    try{const {status}=await read({mode:'connection'});setView(current=>current?{...current,status}:current);}catch{}
  },[read]);
  React.useEffect(()=>{
    if(busy!=='prepare'&&busy!=='importKernel')return;
    const timer=setInterval(()=>{void refreshStatus();},1_200);
    return()=>clearInterval(timer);
  },[busy,refreshStatus]);

  const act=async(name,action)=>{
    setBusy(name);setError('');setNotice('');
    try{await action();setNotice(t(name==='prepare'?'prepared':name==='importKernel'?'imported':'saved'));await load(chat);}catch(caught){setError(['prepare','importKernel'].includes(name)?kernelErrorText(t,caught):t('failedAction'));}finally{setBusy('');}
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
        state.kernel.state==='unsupported'?h('p',{className:'jand-error',role:'alert'},t('unsupportedShort')):null,
        h('p',{className:'jand-muted'},t('autoHint')),
        state.relay===PUBLIC_RELAY?h('p',{className:'jand-muted'},t('defaultRelayShort')):null,
        state.health.state!=='online'?h('p',null,t('tokenUnknown')):state.health.access===true?h('p',null,t(state.creation==='token_required'?'tokenNeeded':'tokenSaved')):null,
        h('div',{className:'jand-links'},button(t('securityGuide'),()=>navigate('security'),{className:'jand-text-button'}),button(t('selfHostGuide'),()=>navigate('selfhost'),{className:'jand-text-button'})),
        page==='settings'?h(ConnectionSettings,{state,relay,setRelay,token,setToken,tokenFile,setTokenFile,importPath,setImportPath,formId,t,busy,act,configure,prepare,importKernel,saveToken,refresh:()=>load('')}):null),
      h(Overview,{items:view.conversations,t}),h(RecordList,{items:view.conversations,t,onSelect:id=>{setNotice('');setPage('home');setChat(id);}})));
}
return {inject:['slots','locale','remote'],async apply(ctx){
  ctx.locale.register(NS,{zh,en});
  await ctx.remote.$mount(clientContribution(z));
  ctx.inject(['remote.jandPanel'],panelCtx=>{
    const call=name=>async request=>{const result=await panelCtx.remote.jandPanel[name](request);if(!result.ok)throw result.error;return result.value;};
    const callbacks={read:call('read'),configure:call('configure'),prepare:call('prepare'),importKernel:call('importKernel'),saveToken:call('saveToken')};
    panelCtx.slots.inject('settings.section',()=>panelCtx.slots.register({name:'settings.section',id:'jand',order:30,label:()=>panelCtx.locale.bind(NS)('nav'),locale:NS,inject:()=>callbacks},Panel));
  });
}};
