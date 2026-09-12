// Exercise the actual frontend transport with controlled DOM / WebSocket adapters.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

async function frontend() {
  const elements = new Map(), connections = [], memoryUpdates = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value:'', textContent:'', dataset:{}, classList:{toggle(){}}, append(){}});
    return elements.get(id);
  };
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0; this.sent = []; connections.push(this);
      setImmediate(() => { if (this.readyState === 3) return; this.readyState = 1; this.onopen?.(); });
    }
    send(data) {
      const m = JSON.parse(data); this.sent.push(m);
      if (m.type === 'session.start') setImmediate(() => this.onmessage?.({data:JSON.stringify({type:'session.ready'})}));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const ui = {state(){}, clear(){}, bubble(){return element('bubble');}, memory(...args){memoryUpdates.push(args);}};
  const win = {zhijianUI:ui, addEventListener(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../static/voice.js'),'utf8'), {
    window:win, document:{getElementById:element}, selectedExpert:0,
    location:{protocol:'http:',host:'test.invalid'}, WebSocket:Socket,
    crypto:require('node:crypto').webcrypto, setTimeout, clearTimeout,
    fetch:async()=>({ok:true,json:async()=>({capabilities:{llm:true,asr:false,tts:false},qa:[],profile:{confirmed:{experience:['金融实习']}}})}),
    questionSets:[], renderSuggestedQuestions(){}, toast(){}
  });
  await new Promise(setImmediate);
  return {win,element,connections,memoryUpdates};
}

test('demo profile reaches first connection, blank mode resets, and reconnect keeps the selected mode', async () => {
  const {win,element,connections,memoryUpdates} = await frontend();
  element('chatInput').value = '我的实习可以怎么迁移？';
  await win.zhijianVoice.send();
  assert.equal(connections[0].sent.find(x=>x.type==='session.start').use_demo_profile,true);
  assert.equal(memoryUpdates.at(-1)[0],true);
  win.zhijianVoice.setDemoProfile(false);
  assert.equal(element('chatBody').textContent,'');
  assert.equal(connections[0].readyState,3);
  assert.equal(memoryUpdates.at(-1)[0],false);
  element('chatInput').value = '空白场景';
  await win.zhijianVoice.send();
  assert.equal(connections[1].sent.find(x=>x.type==='session.start').use_demo_profile,false);
  element('resetSession').onclick();
  element('chatInput').value = '仍然空白';
  await win.zhijianVoice.send();
  assert.equal(connections[2].sent.find(x=>x.type==='session.start').use_demo_profile,false);
  win.zhijianVoice.setDemoProfile(true);
  element('voiceTextInput').value = '语音窗口里的问题';
  element('voiceTextSend').onclick();
  for (let i=0;i<10 && !connections[3]?.sent.some(x=>x.type==='input.text');i++) await new Promise(setImmediate);
  assert.equal(connections[3].sent.find(x=>x.type==='session.start').use_demo_profile,true);
  assert.equal(connections[3].sent.find(x=>x.type==='input.text').text,'语音窗口里的问题');
  connections[3].close();
});
