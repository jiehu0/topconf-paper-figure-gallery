import https from 'node:https';
import {lookup} from 'node:dns';
import {BlockList,isIP} from 'node:net';
import {Readable} from 'node:stream';

const denied=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['192.0.2.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])denied.addSubnet(ip,bits);

// Resolve and pin a public address for each HTTPS request. Provider image URLs
// cannot reach the host's loopback, private services or cloud metadata endpoints.
export async function publicFetch(url,init={}){
  const target=new URL(url);
  if(target.protocol!=='https:'||target.username||target.password||target.port||isIP(target.hostname.replace(/^\[|\]$/g,''))||!target.hostname.includes('.'))throw Error('UNSAFE_IMAGE_URL');
  const request=new Request(target,init),body=request.body?Buffer.from(await request.arrayBuffer()):undefined;
  return new Promise((resolve,reject)=>{
    const outgoing=https.request(target,{method:request.method,headers:Object.fromEntries(request.headers),signal:request.signal,
      family:4,lookup(host,_options,callback){lookup(host,{family:4},(error,address)=>{
        if(error)return callback(error);if(denied.check(address))return callback(Error('UNSAFE_IMAGE_ADDRESS'));
        callback(null,address,4);
      });}},incoming=>{
        const headers=new Headers();for(const [name,value]of Object.entries(incoming.headers))if(value!==undefined)for(const v of Array.isArray(value)?value:[value])headers.append(name,v);
        const empty=[204,205,304].includes(incoming.statusCode);
        if(empty)incoming.resume();
        resolve(new Response(empty?null:Readable.toWeb(incoming),{status:incoming.statusCode,headers}));
      });
    outgoing.on('error',reject);outgoing.end(body);
  });
}
