// Shared, browser-safe wire contract. Host and Client use the same schemas.
export function panelSpec(z) {
  const schemas={read:z.strictObject({chat:z.string().regex(/^[a-f0-9]{32}$/).optional()}),configure:z.strictObject({relay:z.string().optional(),token_file:z.string().optional()}),prepare:z.strictObject({}),saveToken:z.strictObject({value:z.string().min(1).max(8192)})};
  return {package:'@xiaomao361/dsh-jand',methods:Object.fromEntries(Object.entries(schemas).map(([name,schema])=>{
    const codec={mode:'strict',typeSymbol:`@xiaomao361/dsh-jand#${name}`,create:()=>schema,jsonSchema:z.toJSONSchema(schema)};
    return ['jandPanel/'+name,{service:'jandPanel',invocation:{kind:'direct'},parameters:[{name:'request',wire:'request',source:'json',codec,strictCodec:codec}],result:{mode:'strict',typeSymbol:'@xiaomao361/dsh-jand#result',create:()=>z.json(),jsonSchema:{}}}];
  }))};
}
export function clientContribution(z) {
  const spec=panelSpec(z);
  return {package:spec.package,descriptors:Object.entries(spec.methods).map(([endpoint,definition])=>({...definition,id:spec.package+'#'+endpoint,namespace:'jandPanel',method:endpoint.split('/')[1]}))};
}
