import { TypertRemoteService, Remote, RemoteError, createTypertRemoteInfo, principalOf } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { status,configure } from './onboarding.js';
import { readHistory } from './history.js';
import {panelSpec} from './panel-contract.js';

const codecs={
  read:z.strictObject({chat:z.string().regex(/^[a-f0-9]{32}$/).optional()}),
  configure:z.strictObject({relay:z.string().optional(),token_file:z.string().optional()}),
  prepare:z.strictObject({}),saveToken:z.strictObject({value:z.string().min(1).max(8192)})
};
export const panelRemote=createTypertRemoteInfo(panelSpec(z),z);

// Standard Remote decorator API, applied explicitly so no build/transpiler is
// required by this plain-JavaScript Host bundle.
const initializers=[];
export class JandPanel extends TypertRemoteService {
  constructor(ctx,manager) {
    super(ctx,'jandPanel');this.manager=manager;
    for(const initialize of initializers)initialize.call(this);
  }
  assertOwner() {
    if(principalOf(this.ctx.invocation))throw new RemoteError('gateway/forbidden','jand settings and history belong to this profile owner.',{});
  }
  async read(request) {
    this.assertOwner();codecs.read.parse(request);
    const manager=this.manager;
    const [connection,history]=await Promise.all([status(manager),readHistory(manager,request.chat)]);
    return {status:connection,...history};
  }
  async configure(request) {
    this.assertOwner();codecs.configure.parse(request);
    try{return configure(this.manager,request);}catch{throw new RemoteError('gateway/bad-request','Settings could not be saved. Check the relay, token file and active listeners.',{});}
  }
  async prepare(request) {
    this.assertOwner();codecs.prepare.parse(request);
    try{await this.manager.kernel(this.manager.root);return status(this.manager);}
    catch(error){throw new RemoteError('gateway/bad-request',error instanceof Error?error.message:'Kernel preparation failed.',{});}
  }
  async saveToken(request) {
    this.assertOwner();
    try {const {value}=codecs.saveToken.parse(request);this.manager.saveToken(value);return {outcome:'configured',tokenConfigured:true};}
    catch{throw new RemoteError('gateway/bad-request','The token could not be saved. Use the personal token issued by this relay operator.',{});}
  }
}
for(const name of Object.keys(codecs))Remote(JandPanel.prototype[name],{kind:'method',name,static:false,private:false,addInitializer:fn=>initializers.push(fn)});
export function mountPanel(ctx,manager) {
  new JandPanel(ctx,manager);
  // Host registers descriptors; the Client mounts the same contract in its
  // own registry. No source fallback, ad-hoc HTTP route or UI shell is used.
  ctx.typert.register({package:panelRemote.package,face:'host',schemas:[],invocations:panelRemote.descriptors,model:{services:[]}});
}
