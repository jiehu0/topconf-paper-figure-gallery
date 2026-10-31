import assert from 'node:assert/strict';
import {test} from 'node:test';
import {requestChat,requestSvgChat,pdfResponseJSON,pdfRepairBody} from './chat-api.mjs';

test('custom SVG streaming preserves model, references and budget and buffers a complete SVG',async()=>{
  const body={model:'gpt-6-astra',max_tokens:96000,temperature:.3,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,FIXTURE'}}]}]};
  const options={method:'POST',headers:{Authorization:'Bearer fake'},body:JSON.stringify(body)};
  let calls=0;
  const r=await requestSvgChat('https://example.invalid/v1/chat/completions',options,true,async(url,init)=>{
    calls++;assert.equal(url,'https://example.invalid/v1/chat/completions');assert.deepEqual(init.headers,options.headers);
    assert.deepEqual(JSON.parse(init.body),{...body,stream:true});
    return new Response(': keepalive\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{content:'<svg>'}}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{content:'</svg>'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  });
  assert.equal((await r.json()).choices[0].message.content,'<svg></svg>');assert.equal(calls,1);
  assert.equal(JSON.parse(options.body).stream,undefined);
});
test('SVG delivery preserves non-stream callers, JSON fallbacks and gateway error bodies',async()=>{
  const body={model:'same-model',messages:[]}, options={body:JSON.stringify(body)};
  for(const stream of [false,true])for(const status of [200,400,524]){
    const r=await requestSvgChat('https://example.invalid',options,stream,async(_url,init)=>{
      assert.deepEqual(JSON.parse(init.body),stream?{...body,stream:true}:body);
      return new Response(status===200?'{"choices":[]}':'gateway error',{status,headers:{'content-type':'application/json'}});
    });
    assert.equal(r.status,status);assert.equal(await r.text(),status===200?'{"choices":[]}':'gateway error');
  }
});
test('interrupted SVG streams fail once instead of returning or retrying partial output',async()=>{
  let calls=0;
  await assert.rejects(requestSvgChat('x',{body:'{}'},true,async()=>{
    calls++;return new Response('data: {"choices":[{"index":0,"delta":{"content":"<svg>"}}]}\n\n',{headers:{'content-type':'text/event-stream'}});
  }),/提前中断/);
  assert.equal(calls,1);
});

test('504 recovery preserves reference pixels, model and reasoning settings',async()=>{
  const options={method:'POST',body:JSON.stringify({model:'gpt-6-astra',reasoning_effort:'high',
    messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]}]})};
  const requests=[];
  const result=await requestChat('https://example.invalid',options,5000,async(_,init)=>{
    requests.push(init.body);
    return new Response(requests.length===1?'service timeout':'ok',{status:requests.length===1?504:200});
  });
  assert.equal(result.status,200);assert.deepEqual(requests,[options.body,options.body]);
});
test('authentication, request rejection and ambiguous network errors are not retried',async()=>{
  for(const status of [400,401,403,422,429]){
    let calls=0;
    const result=await requestChat('https://example.invalid',{},1000,async()=>{
      calls++;return new Response('rejected',{status});
    });
    assert.equal(result.status,status);assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(requestChat('https://example.invalid',{},1000,async()=>{
    calls++;throw new TypeError('connection lost');
  }),/connection lost/);
  assert.equal(calls,1);
});
test('PDF normalizes chat, Responses and Anthropic final content',()=>{
  const result={selectedSections:[{section:'Method',summary:'Encoder followed by a decoder.'}]};
  const text=JSON.stringify(result);
  for(const data of [
    {choices:[{message:{content:'```json\n'+text+'\n```'},finish_reason:'stop'}]},
    {output:[{content:[{type:'output_text',text}]}]},
    {content:[{type:'text',text}]},
    {choices:[{message:{content:[{type:'text',text}]}}]}
  ]) assert.deepEqual(pdfResponseJSON(data),result);
});
test('empty, truncated, malformed or wrong-schema PDF results cannot be accepted as paper content',()=>{
  for(const data of [
    {choices:[{message:{content:'',reasoning_content:'{"selectedSections":[{"summary":"do not use reasoning"}]}'}}]},
    {choices:[{finish_reason:'length',message:{content:'{"selectedSections":[{"summary":"partial"}]}'}}]},
    {choices:[{message:{content:'not JSON'}}]},
    {choices:[{message:{content:'{"nodes":[]}'}}]},
  ]) assert.throws(()=>pdfResponseJSON(data),e=>e.pdfFormatFailure===true);
});
test('format recovery increases reasoning-inclusive budget without modifying paper or input body',()=>{
  const body={model:'deepseek-v4.1-flash',max_tokens:5000,reasoning_effort:'high',
    messages:[{role:'user',content:'Original paper'}]};
  const result=pdfRepairBody(body);
  assert.equal(result.max_tokens,12000);assert.equal(result.reasoning_effort,'high');
  assert.deepEqual(result.messages[0],body.messages[0]);assert.equal(body.messages.length,1);
  const gpt=pdfRepairBody({...body,max_tokens:undefined,max_completion_tokens:8192});
  assert.equal(gpt.max_completion_tokens,16384);
});
