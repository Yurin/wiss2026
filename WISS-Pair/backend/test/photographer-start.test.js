const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.resolve(__dirname, '../../photographer/index.html'), 'utf8');
const source = fs.readFileSync(path.resolve(__dirname, '../../photographer/script.js'), 'utf8');
function element() {
  return {hidden: false, style: {}, dataset: {}, value:'0.5', handlers:{}, classList:{toggle(){},add(){},remove(){}},
    addEventListener(type, fn){this.handlers[type]=fn;},removeEventListener(){},setAttribute(){},appendChild(){},
    getContext(){return {};},getBoundingClientRect(){return {width:300,height:400};}};
}
async function run() {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1],element()]));
  const selectors = new Map();
  const controls = [element(),element()];
  const calls = [], errors = [];
  class Socket {static OPEN=1;static CONNECTING=0;constructor(url){calls.push(url);this.readyState=1;}addEventListener(){}send(){}close(){}}
  const context = vm.createContext({
    document: {getElementById:id=>elements.get(id) || null,querySelector:q=>{if(!selectors.has(q))selectors.set(q,element());return selectors.get(q);},querySelectorAll:()=>controls,createElement:element,addEventListener(){},visibilityState:'visible'},
    window: {location:{protocol:'https:',host:'photo-interface.com:8443',search:'?sessionId=start-test'},addEventListener(){}},
    navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[]})}},
    localStorage:{getItem:()=>null,setItem(){}},WebSocket:Socket,URL,URLSearchParams,AbortController,
    console:{log(){},info(){},warn(){},error:e=>errors.push(String(e))},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    fetch:async(url)=>{calls.push(url);return {ok:true,json:async()=>({success:true,files:[],guide:null})};},
  });
  vm.runInContext(source,context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(errors,[]);
  assert.ok(elements.get('captureBtn').handlers.click);
  assert.ok(elements.get('endCaptureBtn').handlers.click);
  assert.equal(elements.get('capturePanel').hidden,false);
  assert.ok(elements.get('video').srcObject);
  assert.ok(calls.some(url=>url.includes('/ws/session')));
  assert.ok(calls.every(url=>!/(experiments|research|participant)/.test(url)));
  assert.ok(controls.every(e=>e.hidden===false));
  console.log('photographer startup passed: QR session, camera request, controls, no experiment API');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
