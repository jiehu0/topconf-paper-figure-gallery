import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {createJobService} from './server.mjs';
import {archiveBlockedLegacyJobs,createInfistarJobClient} from '../forge/step3-infistar-job.mjs';
const origin='https://paper.boyweb.net',key='fixture-private-key',pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=';
const input={url:'https://api.shuaiapi.com/v1/images/generations',body:{model:'gpt-image-2.5-sunburst',prompt:'private fixture prompt'},usedReferences:false};
async function fixture(fetchImpl){
  const directory=mkdtempSync(join(tmpdir(),'figureforge-jobs-'));
  const start=async()=>{const service=createJobService({directory,fetchImpl});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));return service;};
  let service=await start();
  return {directory,get service(){return service;},async restart(){await service.close();service=await start();},
    async request(id,method='GET',body=input,credential=key,headers={}){return fetch(`http://127.0.0.1:${service.server.address().port}/jobs/${id}`,{method,headers:{Origin:origin,Authorization:'Bearer '+credential,'Content-Type':'application/json',...headers},...(method==='PUT'?{body:JSON.stringify(body)}:{})});},
    async wait(id,state){for(let i=0;i<100;i++){const response=await this.request(id);const data=await response.json();if(data.state===state)return data;await new Promise(r=>setTimeout(r,25));}throw Error('Task did not reach '+state);},
    async close(){await service.close();rmSync(directory,{recursive:true,force:true});}};
}
test('HTTP jobs persist across restart, isolate keys and never repeat a provider POST',async()=>{
  let posts=0;
  const f=await fixture(async(url,init)=>{posts++;assert.equal(url,input.url);assert.equal(new Headers(init.headers).get('Authorization'),'Bearer '+key);return new Response(JSON.stringify({data:[{b64_json:pixel}]}),{headers:{'Content-Type':'application/json'}});});
  try{
    const id=randomUUID();
    const responses=await Promise.all([f.request(id,'PUT'),f.request(id,'PUT')]);assert.deepEqual(responses.map(r=>r.status),[202,202]);
    const state=await f.wait(id,'succeeded');assert.equal(state.upstreamAttempts,1);assert.equal(posts,1);
    const result=await (await f.request(id+'/result')).json();assert.equal(JSON.parse(result.text).data[0].b64_json,pixel);
    assert.equal((await f.request(id,'GET',input,'other-key')).status,404);
    assert.equal((await f.request(id,'PUT',{...input,body:{...input.body,prompt:'different'}})).status,409);
    await f.restart();assert.equal((await f.request(id,'PUT')).status,202);await f.wait(id,'succeeded');assert.equal(posts,1);
    const bytes=readFileSync(join(f.directory,'jobs.sqlite'));assert.equal(bytes.includes(Buffer.from(key)),false);assert.equal(bytes.includes(Buffer.from(input.body.prompt)),false);
    assert.equal((await f.request(id,'GET',input,key,{Origin:'https://untrusted.invalid'})).status,403);
    assert.equal((await f.request(randomUUID(),'PUT',{...input,url:'https://127.0.0.1/v1/images/generations'})).status,400);
  }finally{await f.close();}
});
test('restart after durable claim marks unknown and cannot replay the paid call',async()=>{
  let posts=0;const f=await fixture(async()=>{posts++;throw Error('Unexpected replay');});
  try{
    const id=randomUUID(),namespace='fixture:'+id,storage=f.service.store.storage(namespace);
    await storage.put('meta',{id,owner:'fixture',state:'running',upstreamAttempts:1,created:Date.now(),expires:Date.now()+86400000});
    await f.restart();
    for(let i=0;i<100;i++){if((await f.service.store.storage(namespace).get('meta')).state==='unknown')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal((await f.service.store.storage(namespace).get('meta')).state,'unknown');assert.equal(posts,0);
  }finally{await f.close();}
});
test('same-origin GET without Origin works; preflight and custom multipart keep the contract',async()=>{
  let posts=0;const f=await fixture(async(_url,init)=>{posts++;assert.ok(init.body instanceof FormData);return new Response(JSON.stringify({data:[{b64_json:pixel}]}));});
  try{
    const id=randomUUID();
    const options=await f.request(id,'OPTIONS',input,key,{'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization,content-type'});
    assert.equal(options.status,204);assert.equal(options.headers.get('Access-Control-Allow-Origin'),origin);
    const form={...input,url:'https://api.shuaiapi.com/v1/images/edits',usedReferences:true,body:{multipart:[{name:'model',value:'gpt-image-2.5-sunburst'},{name:'prompt',value:'fixture'},{name:'image[]',file:{name:'reference.png',type:'image/png',b64:pixel}}]}};
    assert.equal((await f.request(id,'PUT',form)).status,202);await f.wait(id,'succeeded');assert.equal(posts,1);
    const status=await new Promise((resolve,reject)=>{http.get(`http://127.0.0.1:${f.service.server.address().port}/jobs/${id}`,{headers:{Host:'paper.boyweb.net','Sec-Fetch-Site':'same-origin',Authorization:'Bearer '+key}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
    assert.equal(status,200);
  }finally{await f.close();}
});
test('only denied, unacknowledged legacy placeholders are archived; confirmed work remains blocked',async()=>{
  const prefix='figureforge:infistar-image-job:v1:',values=new Map([[prefix+'pending',JSON.stringify({id:'old-denied',acknowledged:false})],[prefix+'confirmed',JSON.stringify({id:'confirmed',acknowledged:true})],[prefix+'new',JSON.stringify({id:'new',acknowledged:false,endpoint:'/api/image-jobs'})]]);
  const storage={get length(){return values.size;},key:i=>[...values.keys()][i],getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  assert.equal(archiveBlockedLegacyJobs(storage,false),0);assert.equal(archiveBlockedLegacyJobs(storage,true),1);
  assert.equal(values.has(prefix+'pending'),false);assert.equal(values.has('figureforge:blocked-legacy-image-job:v1:pending'),true);assert.equal(values.has(prefix+'confirmed'),true);assert.equal(values.has(prefix+'new'),true);
  let calls=0;const old={id:'confirmed',acknowledged:true,fingerprint:'fixture'};
  const c=createInfistarJobClient({endpoint:'/api/image-jobs',storage:{getItem:()=>JSON.stringify(old)},withLock:async(_n,fn)=>fn(),fetchImpl:()=>{calls++;}});
  await assert.rejects(c.request({...input,key}),{code:'JOB_BACKEND_CHANGED'});assert.equal(calls,0);
});
