// Mocked browser integration: custom gateways need no live credentials or credits.
// PLAYWRIGHT_CORE_PATH and CHROME_PATH may point to an existing local installation.
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH||'playwright-core');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
  let pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname.endsWith('/'))pathname+='index.html';
  const filename=path.resolve(root,'.'+decodeURIComponent(pathname));
  if(!filename.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  fs.readFile(filename,(err,data)=>{
    if(err){res.writeHead(404);return res.end();}
    if(pathname==='/forge/index.html')data=Buffer.from(data.toString().replace(/\r\n/g,'\n')
      .replace('window.__ffReconstruct = () => runReconstruction();',`window.__customTest={
        parse:callPdfParser,analyze:analyzeReferences,image:genOaiImage,scene:requestEditableScene,svg:genOaiSVG,repair:repairSVG,
        model:generationModel,parser:parserModel,base:baseURL,
        seed(){
          pdfContext={fileName:'fixture.pdf',dataUri:'data:application/pdf;base64,PDF_FIXTURE'};
          const figs=Array.from({length:4},(_,i)=>({id:'ref-'+i,title:'Framework',venue:'iclr',year:2025,pattern:'framework',image:'fixture.jpg'}));
          data={figs,ids:figs.map(f=>f.id),N:4}; refs=new Set(data.ids);
          refDataURIs=async()=>Array(4).fill('data:image/png;base64,PIXEL_FIXTURE');
          runReconstruction=async()=>null;
          auditAndRepair=async svg=>({svg,audit:{defects:[]},first:0});
        }
      };`)
      .replace("onBootState(bootStatus);\nawait loadManifest();\ninitProviders();\nsyncSubCount();\nconst startupModels=Promise.all([populateModels(), populateParserModels()]);\nawait boot();\nawait startupModels;\n$('#manifestHint').textContent = tt('manifest.hint',{d:MAN.updated});",
        'MAN=structuredClone(FALLBACK);initProviders();await Promise.all([populateModels(),populateParserModels()]);'));
    res.writeHead(200,{'Content-Type':/\.m?js$/.test(filename)?'text/javascript':filename.endsWith('.html')?'text/html':'application/octet-stream'});res.end(data);
  });
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  try{
    // Playwright's service-worker blocking init script throws inside sandboxed
    // SVG preview frames. The app worker only intercepts same-origin assets.
    const page=await browser.newPage(),requests=[],errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const lastPost=()=>requests.filter(r=>r.body).at(-1);
    let modelsAvailable=false;
    await page.route('https://gateway.invalid/**',async route=>{
      const req=route.request();requests.push({url:req.url(),headers:req.headers(),body:req.method()==='POST'?req.postDataJSON():null});
      if(req.url().endsWith('/models'))return route.fulfill({status:modelsAvailable?200:404,json:modelsAvailable?{data:[{id:'account-parser'},{id:'gpt-image-2'}]}:{error:'No catalog'}});
      if(req.postDataJSON()?.stream){
        const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect x="10" y="10" width="300" height="100" fill="#ddd"/></svg>';
        return route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({choices:[{index:0,delta:{content:svg},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'});
      }
      const content={selectedSections:[{section:'Method',summary:'Fixture method.'}],representative:[1,2],refinedPrompt:'A structured framework.',nodes:[{id:'box',type:'rect',x:10,y:10,w:40,h:40,fill:'#ffffff'}]};
      return route.fulfill({json:{choices:[{message:{content:JSON.stringify(content)}}]}});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/forge/`);
    await page.waitForFunction(()=>!!window.__customTest);
    await page.selectOption('#provider','custom');
    assert.equal(await page.locator('#relayRow').isVisible(),true);
    assert.equal(await page.locator('#parseCustomModelRow').isVisible(),true);
    await page.fill('#baseOverride','https://gateway.invalid/api/v1///');
    await page.fill('#key','fixture-key');
    await page.fill('#parseCustomModel','my-parser');
    await page.fill('#customModel','my-painter');
    assert.equal(await page.locator('#model').inputValue(),'my-painter');
    await page.fill('#customVisionModel','my-vision-alias');
    await page.click('#refreshModels');
    assert.equal(await page.evaluate(()=>window.__customTest.base()),'https://gateway.invalid/api/v1');
    // An unavailable /models must never gate manual model IDs.
    assert.equal(await page.locator('#reconModel').inputValue(),'my-vision-alias');
    await page.evaluate(()=>window.__customTest.seed());
    await page.evaluate(()=>window.__customTest.svg(window.__customTest.base(),window.__customTest.model(),'fixture-key','Draw the method','custom',undefined,''));
    assert.equal(lastPost().body.stream,true);
    assert.equal(lastPost().body.model,'my-painter');
    assert.equal(lastPost().body.messages[1].content.filter(p=>p.type==='image_url').length,4);
    assert.equal(await page.locator('#out iframe').count(),1);
    await page.evaluate(()=>window.__customTest.repair('<svg/>',[{detail:'Move one label',fix:'Shift right'}],{base:window.__customTest.base(),model:window.__customTest.model(),key:'fixture-key',provider:'custom'}));
    assert.equal(lastPost().body.stream,true);
    assert.equal(lastPost().body.max_tokens,96000);
    await page.click('[data-mode="image"]');
    await page.evaluate(()=>window.__customTest.seed());
    assert.equal(await page.locator('#analyzeModel').inputValue(),'my-vision-alias');
    for(const mode of ['text','doc','img']){
      await page.evaluate(mode=>window.__customTest.parse(mode,{text:'Fixture paper',pages:1,total:1,imgs:['data:image/png;base64,PIXEL_FIXTURE']}),mode);
      assert.equal(lastPost().url,'https://gateway.invalid/api/v1/chat/completions');
      assert.equal(lastPost().body.model,'my-parser');
      assert.equal(lastPost().headers.authorization,'Bearer fixture-key');
    }
    await page.evaluate(()=>window.__customTest.analyze());
    assert.equal(lastPost().body.model,'my-vision-alias');
    assert.equal(lastPost().body.messages[1].content.filter(p=>p.type==='image_url').length,4);
    await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=100;canvas.height=100;
      await window.__customTest.scene(canvas.toDataURL(),100,100,{objectRepair:true,catalog:{canvas:{width:100,height:100},nodes:[{id:'box',type:'rect',x:10,y:10,w:40,h:40}]}});
    });
    assert.equal(lastPost().body.model,'my-vision-alias');
    await page.selectOption('#figureRatio','1:1');
    const pixel=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=2048;c.height=2048;return c.toDataURL().split(',')[1];});
    await page.route('https://gateway.invalid/api/v1/images/generations',route=>{
      requests.push({url:route.request().url(),body:route.request().postDataJSON()});
      return route.fulfill({json:{data:[{b64_json:pixel}]}});
    });
    await page.evaluate(()=>window.__customTest.image(window.__customTest.base(),window.__customTest.model(),'fixture-key','Draw the method','custom',[],''));
    assert.equal(lastPost().body.model,'my-painter');
    assert.equal(await page.locator('#dlImg').isEnabled(),true);
    modelsAvailable=true;
    await page.click('#refreshModels');
    await page.waitForFunction(()=>[...document.querySelector('#parseModel').options].some(o=>o.value==='account-parser'));
    assert.equal(await page.evaluate(()=>window.__customTest.parser()),'my-parser');
    await page.fill('#parseCustomModel','');
    await page.selectOption('#parseModel','account-parser');
    assert.equal(await page.evaluate(()=>window.__customTest.parser()),'account-parser');
    await page.fill('#parseCustomModel','my-parser');
    await page.reload();
    await page.waitForFunction(()=>!!window.__customTest);
    for(const [id,value] of [['provider','custom'],['key','fixture-key'],['baseOverride','https://gateway.invalid/api/v1///'],['parseCustomModel','my-parser'],['customModel','my-painter'],['model','my-painter'],['customVisionModel','my-vision-alias'],['reconModel','my-vision-alias']])assert.equal(await page.locator('#'+id).inputValue(),value);
    await page.selectOption('#provider','oai');
    assert.equal(await page.locator('#key').inputValue(),'');
    assert.equal(await page.locator('#relayToggle').isVisible(),true);
    await page.check('#useRelay');
    assert.equal(await page.locator('#relayRow').isVisible(),true);
    assert.deepEqual(errors,[]);
    console.log('PASS custom model catalog, manual PDF/vision/image requests, persistence and provider isolation');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
