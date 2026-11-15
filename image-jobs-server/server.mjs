import http from 'node:http';
import {Readable} from 'node:stream';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import worker,{ImageJob} from '../infistar-image-relay/worker.mjs';
import {openStore} from './storage.mjs';
import {publicFetch} from './fetch.mjs';

export function createJobService({directory,origins='https://paper.boyweb.net',extraHosts=['api.shuaiapi.com'],fetchImpl=publicFetch,concurrency=4}={}){
  globalThis.FF_IMAGE_JOB_HOSTS=extraHosts;
  const store=openStore(directory),objects=new Map(),active=new Map();let stopping=false;
  const env={ALLOWED_ORIGINS:origins,JOB_ENCRYPTION_KEY:store.key,DIRECT_IMAGE_FETCH:true,IMAGE_FETCH:fetchImpl};
  env.IMAGE_JOBS={idFromName:value=>value,get(namespace){
    if(!objects.has(namespace))objects.set(namespace,new ImageJob({storage:store.storage(namespace),blockConcurrencyWhile:fn=>store.lock('claim:'+namespace,fn)},env));
    return objects.get(namespace);
  }};
  store.recover();
  function tick(){
    if(stopping)return;
    for(const namespace of store.due()){
      if(active.size>=concurrency)break;if(active.has(namespace))continue;
      const job=Promise.resolve().then(()=>env.IMAGE_JOBS.get(namespace).alarm()).catch(()=>{}).finally(()=>active.delete(namespace));
      active.set(namespace,job);
    }
  }
  const timer=setInterval(tick,250);timer.unref();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method==='GET'&&req.url==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
    try{
      const headers=new Headers(req.headers);
      // Same-origin GET fetches omit Origin. Only accept that browser signal
      // for the configured public host; the API key is still mandatory.
      if(!headers.has('origin')&&headers.get('sec-fetch-site')==='same-origin'){
        const origin=origins.split(',').find(value=>new URL(value).host===headers.get('host'));
        if(origin)headers.set('origin',origin);
      }
      const request=new Request('https://image-jobs.internal'+req.url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
      const response=await worker.fetch(request,env);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)Readable.fromWeb(response.body).on('error',()=>res.destroy()).pipe(res);else res.end();
    }catch{
      if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});
      res.end('{"error":"JOB_SERVICE_ERROR"}');
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  return {server,store,async close(){stopping=true;clearInterval(timer);await new Promise(r=>server.close(r));await Promise.allSettled(active.values());store.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const service=createJobService({directory:process.env.JOB_DATA_DIR||'/data',origins:process.env.ALLOWED_ORIGINS||'https://paper.boyweb.net',extraHosts:(process.env.IMAGE_JOB_HOSTS||'api.shuaiapi.com').split(',').filter(Boolean)});
  service.server.listen(Number(process.env.PORT)||8081,'0.0.0.0',()=>console.log('Image job service ready'));
  let closing=false;
  const stop=()=>{if(closing)return;closing=true;service.close().then(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
