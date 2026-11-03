import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
const fibersByContext = new WeakMap();
export async function disposeRuntime(ctx) {
  for (const fiber of [...fibersByContext.get(ctx)].reverse()) await fiber.dispose();
}
export async function runtime(adapter) {
  const ctx = new Context();
  const fibers=[]; fibersByContext.set(ctx,fibers);
  const packages = ['dsh-llm','dsh-session','dsh-system-prompt','dsh-tools','dsh-session-projection','dsh-agent','dsh-jobs-local','dsh-agent-loop','dsh-tool-jobs'];
  for (const name of packages) {
    const mod = await import(`@deepseek-ai/${name}`);
    const fiber = ctx.plugin(mod.default ?? mod, name === 'dsh-system-prompt' ? {includeHarnessIdentity:false,includeRuntimeContext:false} : {});
    await fiber;
    fibers.push(fiber);
    if (fiber.error) throw fiber.error;
  }
  ctx.llm.registerAdapter(['fixture'], adapter);
  return ctx;
}
export class FixtureAdapter extends LlmAdapter {
  constructor(respond) { super(); this.respond = respond; }
  async *stream(options) {
    const response = await this.respond(options);
    if (typeof response === 'string') {
      yield {type:'block-start',blockType:'text', index:0};
      yield {type:'text-delta',text:response,index:0};
    } else {
      yield {type:'block-start', index:0, blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id:response.id,name:response.name,argumentsDelta:JSON.stringify(response.input)};
    }
    yield {type:'finish',reason:{kind:'stop'}};
  }
}
