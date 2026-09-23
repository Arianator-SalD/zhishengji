// Exercise the actual frontend transport with controlled DOM / WebSocket adapters.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

async function frontend(options = {}) {
  const elements = new Map(), connections = [], memoryUpdates = [], bubbles = [], requests = [];
  const configs = id => ({expert_id:id,default_use_demo_profile:true,capabilities:{llm:true,asr:false,tts:false},qa:[{question:id+' question'}],profile:{confirmed:{experience:[id+' profile']}}});
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value:'', textContent:'', dataset:{}, classList:{toggle(){}}, append(){}});
    return elements.get(id);
  };
  class Socket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0; this.sent = []; connections.push(this);
      setImmediate(() => { if (this.readyState === 3) return; this.readyState = 1; this.onopen?.(); });
    }
    send(data) {
      const m = JSON.parse(data); this.sent.push(m);
      if (m.type === 'session.start' && !options.manualReady) setImmediate(() => this.emit({type:'session.ready',expert_id:new URL(this.url).searchParams.get('expert_id')}));
    }
    emit(m) { this.onmessage?.({data:JSON.stringify(m)}); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const ui = {state(){}, clear(){}, bubble(container,text,who){ const node={textContent:text,append(){}}; bubbles.push({container,text,who,node}); return node;}, memory(...args){memoryUpdates.push(args);}};
  const win = {zhijianUI:ui, addEventListener(){}};
  const context = vm.createContext({
    window:win, document:{getElementById:element}, selectedExpert:0,
    experts:[{voiceId:'sally',name:'Sally'},{voiceId:'robin-li',name:'李彦宏'},{name:'Mock'}],
    location:{protocol:'http:',host:'test.invalid'}, WebSocket:Socket,
    crypto:require('node:crypto').webcrypto, setTimeout:options.setTimeout || setTimeout, clearTimeout:options.clearTimeout || clearTimeout,
    fetch: url => {
      const id = new URL(url, 'http://test.invalid').searchParams.get('expert_id');
      requests.push(id);
      if (options.fetch) return options.fetch(id, configs(id));
      return Promise.resolve({ok:true,json:async()=>configs(id)});
    },
    AudioContext: options.AudioContext, navigator:options.navigator,
    questionSets:[], renderSuggestedQuestions(){}, toast(){throw new Error('Unexpected toast');}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/voice.js'),'utf8'), context);
  await new Promise(setImmediate);
  return {win,element,connections,memoryUpdates,bubbles,requests,context,select(i){context.selectedExpert=i;win.zhijianVoice.select(i);}};
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
  win.zhijianVoice.reset();
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

const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };

test('live expert switch closes the old socket, clears drafts, ignores late frames and restores Sally mode', async () => {
  const f = await frontend();
  f.element('chatInput').value = 'Sally question'; await f.win.zhijianVoice.send();
  const old = f.connections[0], request = old.sent.find(m=>m.type==='input.text');
  f.element('chatBody').textContent = 'old answer'; f.element('voiceTextInput').value = 'old draft';
  f.select(1);
  assert.equal(old.readyState,3);
  assert.equal(f.element('chatBody').textContent,'');
  assert.equal(f.element('voiceTextInput').value,'');
  assert.equal(f.memoryUpdates.at(-1)[0],false);
  assert.equal(f.memoryUpdates.at(-1)[1],null);
  const count = f.bubbles.length;
  old.emit({type:'reply.delta',request_id:request.request_id,turn_id:'old',text:'leaked'});
  old.emit({type:'error',message:'old error'});
  assert.equal(f.bubbles.length,count);
  f.element('chatInput').value = 'Robin question'; await f.win.zhijianVoice.send();
  assert.match(f.connections[1].url,/expert_id=robin-li$/);
  assert.equal(f.connections[1].sent.find(m=>m.type==='session.start').use_demo_profile,true);
  f.select(0);
  f.element('chatInput').value = 'Sally again'; await f.win.zhijianVoice.send();
  assert.match(f.connections[2].url,/expert_id=sally$/);
  assert.equal(f.connections[2].sent.find(m=>m.type==='session.start').use_demo_profile,true);
  f.select(2);
});

test('delayed old config cannot replace the selected expert profile or clear its pending request', async () => {
  const pending=[];
  const f=await frontend({fetch(id,config){const d=deferred();pending.push({id,config,...d});return d.promise;}});
  f.select(1);
  pending[0].resolve({ok:true,json:async()=>pending[0].config}); await tick();
  assert.equal(f.memoryUpdates.at(-1)[2],'robin-li');
  assert.equal(f.memoryUpdates.at(-1)[1],null);
  f.element('chatInput').value='Robin'; const sending=f.win.zhijianVoice.send();
  assert.equal(pending.length,2);
  pending[1].resolve({ok:true,json:async()=>pending[1].config}); await sending;
  assert.equal(f.memoryUpdates.at(-1)[1].confirmed.experience[0],'robin-li profile');
  assert.deepEqual(f.requests,['sally','robin-li']);
  f.select(2);
});

test('late old socket close cannot clear a newer connection awaiting session.ready', async () => {
  const f=await frontend({manualReady:true});
  f.element('chatInput').value='Sally'; const first=f.win.zhijianVoice.send(); await tick();
  f.select(1); f.element('chatInput').value='Robin'; const second=f.win.zhijianVoice.send(); await tick();
  f.connections[0].onclose();
  f.element('chatInput').value='Robin latest'; const third=f.win.zhijianVoice.send(); await tick();
  assert.equal(f.connections.length,2);
  f.connections[1].emit({type:'session.ready',expert_id:'robin-li'});
  await Promise.all([first,second,third]);
  assert.equal(f.connections[1].sent.filter(m=>m.type==='input.text').length,1);
  assert.equal(f.connections[1].sent.find(m=>m.type==='input.text').text,'Robin latest');
  f.select(2);
});

test('switch during suspended audio context cancels the pending voice turn', async () => {
  const resumed=deferred();
  class Context { constructor(){this.state='suspended';} resume(){return resumed.promise;} }
  const f=await frontend({AudioContext:Context,fetch:async(id,c)=>({ok:true,json:async()=>({...c,capabilities:{...c.capabilities,tts:true}})})});
  f.element('voiceTextInput').value='old voice request'; const sending=f.element('voiceTextSend').onclick(); await tick();
  f.select(1); resumed.resolve(); await sending;
  assert.equal(f.connections.length,0);
  assert.equal(f.bubbles.length,0);
  f.select(2);
});


test('a profile choice made before config resolves survives the fetch and resets', async () => {
  const pending=[];
  const f=await frontend({fetch(id,config){const d=deferred();pending.push({config,...d});return d.promise;}});
  f.win.zhijianVoice.setDemoProfile(false);
  f.element('chatInput').value='blank'; const sending=f.win.zhijianVoice.send();
  pending[0].resolve({ok:true,json:async()=>pending[0].config});
  pending[1].resolve({ok:true,json:async()=>pending[1].config}); await sending;
  assert.equal(f.connections[0].sent.find(m=>m.type==='session.start').use_demo_profile,false);
  assert.equal(f.memoryUpdates.at(-1)[0],false);
  f.select(2);
});

test('Robin case is shared by text and call; blank mode restores generic questions and survives expert switches', async () => {
  const profile=JSON.parse(fs.readFileSync(path.join(__dirname,'../content/robin-li/demo_user.json'),'utf8'));
  const f=await frontend({fetch:async(id,c)=>({ok:true,json:async()=>({...c,profile:id==='robin-li'?profile:c.profile})})});
  f.select(1);await tick();
  assert.equal(f.memoryUpdates.at(-1)[0],true);
  assert.equal(f.memoryUpdates.at(-1)[1].id,'demo_robin_student_001');
  assert.deepEqual([...f.context.questionSets[1]],profile.starter_questions);
  f.element('chatInput').value='根据两位同学的反馈，下一步呢？';await f.win.zhijianVoice.send();
  const socket=f.connections[0];
  assert.equal(socket.sent.find(m=>m.type==='session.start').use_demo_profile,true);
  f.element('voiceTextInput').value='我每周只有四小时';await f.element('voiceTextSend').onclick();
  assert.equal(f.connections.length,1);
  assert.equal(socket.sent.filter(m=>m.type==='input.text').length,2);
  f.win.zhijianVoice.setDemoProfile(false);
  assert.deepEqual([...f.context.questionSets[1]],['robin-li question']);
  f.select(0);await tick();assert.equal(f.memoryUpdates.at(-1)[0],true);
  f.select(1);await tick();assert.equal(f.memoryUpdates.at(-1)[0],false);
  f.element('chatInput').value='不带入演示身份';await f.win.zhijianVoice.send();
  assert.equal(f.connections.at(-1).sent.find(m=>m.type==='session.start').use_demo_profile,false);
  f.select(2);
});

test('live welcome omits user profiles before and after config loads and removes profile panels', () => {
  const ids=new Map(), selectors=new Map(), lines=[], created=[], choices=[];
  function element() {
    const children=new Map();
    const node={textContent:'',dataset:{},style:{},hidden:false,isConnected:true,childNodes:[],classList:{toggle(){},remove(){}},
      querySelector(key){if(!children.has(key))children.set(key,element());return children.get(key);},
      querySelectorAll(){return [];},before(){},after(){},append(n){this.childNodes.push(n);},replaceChildren(){this.childNodes=[];},setAttribute(){},remove(){},focus(){}};
    created.push(node);return node;
  }
  const byId=id=>{if(!ids.has(id))ids.set(id,element());return ids.get(id);};
  const selector=s=>{if(!selectors.has(s))selectors.set(s,element());return selectors.get(s);};
  let liveCalls=0,mockCalls=0,selections=0;
  byId('callNext').onclick=()=>mockCalls++;
  const win={zhijianVoice:{beginMic(){liveCalls++;},open(){},startCall(){},setDemoProfile(value){choices.push(value);}},zhijianChat:{select(){selections++;}}};
  const context=vm.createContext({window:win,selectedExpert:1,
    experts:[{name:'Sally',voiceId:'sally',tags:[]},{name:'李彦宏',voiceId:'robin-li',publicFigure:true,tags:[],source:'https://ir.baidu.com/management/robin-li'},{name:'Mock',tags:[]}],
    document:{getElementById:byId,querySelector:selector,createElement:element},
    openModal(){},closeModal(){},startCallDemo(){},stopCallDemo(){},startTimer(){},showPage(){},sendMessage(){},
    callControlIcon(){return '';},escapeHTML:s=>s,
    addCallLine(kind,name,text){const node=element();lines.push({kind,name,text,node});return node;}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/consultation-ui.js'),'utf8'),context);
  win.zhijianUI.memory(false,null,'robin-li');
  win.zhijianUI.prepareCall();
  assert.equal(lines.at(-1).name,'李彦宏 · AI 分身');
  assert.doesNotMatch(lines.at(-1).text,/公开资料/);
  assert.doesNotMatch(lines.at(-1).text,/Sally|已带入/);
  const profile=JSON.parse(fs.readFileSync(path.join(__dirname,'../content/robin-li/demo_user.json'),'utf8'));
  win.zhijianUI.memory(true,profile,'robin-li');
  win.zhijianUI.prepareCall();
  assert.equal(lines.at(-1).text,lines[0].text);
  assert.doesNotMatch(lines.at(-1).text,/林小北|信息管理|档案|已带入|金融|硕士/);
  assert.ok(!created.some(node=>['chatMemory','callMemory','resetSession'].includes(node.id)));
  assert.ok(!created.some(node=>node.className==='chat-session-bar'));
  win.zhijianUI.memory(false,profile,'robin-li');win.zhijianUI.prepareCall();
  assert.equal(lines.at(-1).text,lines[0].text);
  context.selectedExpert=0;
  win.zhijianUI.memory(true,{label:'金融转 AI 产品 · 模拟同学',call_context:'用户的私人背景'},'sally');
  win.zhijianUI.prepareCall();
  assert.match(lines.at(-1).text,/Sally/);
  assert.doesNotMatch(lines.at(-1).text,/私人|金融|档案|已带入/);
  context.selectedExpert=1;
  win.zhijianUI.profile(1);
  assert.equal(selector('.ai-identity-line > span:last-child').textContent,'AI 生成内容，仅供交流参考');
  assert.equal(byId('chatExpertSubtitle').textContent,'AI 分身 · 基于公开资料与本次对话');
  win.zhijianUI.profile(0);
  assert.equal(byId('chatExpertSubtitle').textContent,'AI 分身 · 基于本人资料与精选问答');
  win.zhijianUI.profile(2);
  assert.equal(byId('chatExpertSubtitle').textContent,'AI 分身 · 基于专家经验与真实案例');
  win.zhijianUI.profile(1);
  byId('callNext').onclick(); assert.equal(liveCalls,1); assert.equal(mockCalls,0);
  context.openModal('callModal'); assert.equal(selections,1);
  context.selectedExpert=2; byId('callNext').onclick(); assert.equal(mockCalls,1);
});


test('unconfigured live service reports inline and preserves the draft', async () => {
  const f=await frontend({fetch:async(id,c)=>({ok:true,json:async()=>({...c,capabilities:{llm:false,asr:false,tts:false}})})});
  f.element('chatInput').value='keep my question'; await f.win.zhijianVoice.send();
  assert.equal(f.element('chatInput').value,'keep my question');
  assert.match(f.element('voiceStatus').textContent,/暂时无法连接/);
  assert.equal(f.connections.length,0);
  assert.equal(f.element('voiceStatus').hidden,false);
  f.select(1);await tick();
  assert.equal(f.element('voiceStatus').hidden,true);
  f.select(2);
});


async function microphoneFrontend() {
  const module=deferred(), timers=new Map(); let stopped=0, modules=0, timerId=0;
  class Context {
    constructor(){this.state='running';this.audioWorklet={addModule(){modules++;return module.promise;}};}
  }
  const f=await frontend({AudioContext:Context,
    navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++;}}]})}},
    setTimeout(callback){const id=++timerId;timers.set(id,callback);return id;},
    clearTimeout(id){timers.delete(id);},
    fetch:async(id,c)=>({ok:true,json:async()=>({...c,capabilities:{llm:true,asr:true,tts:true}})})
  });
  return {...f,module,timers,get stopped(){return stopped;},get modules(){return modules;}};
}

test('expert switch cancels a pending worklet setup and releases microphone without waiting for the module', async () => {
  const f=await microphoneFrontend();
  const starting=f.win.zhijianVoice.beginMic();
  for(let i=0;i<10 && !f.modules;i++) await tick();
  assert.equal(f.modules,1);
  assert.equal(f.element('voiceStatus').textContent,'正在准备麦克风…');
  assert.equal(f.timers.size,1);
  f.select(1); await starting;
  assert.equal(f.stopped,1);
  assert.equal(f.timers.size,0);
  f.module.resolve(); await tick();
  assert.equal(f.connections[0].sent.some(m=>m.type==='audio.start'),false);
  assert.doesNotMatch(f.element('voiceStatus').textContent,/初始化超时|准备已取消/);
  f.select(2);
});

test('worklet initialization timeout releases its track and reports an inline recovery message', async () => {
  const f=await microphoneFrontend();
  const starting=f.win.zhijianVoice.beginMic();
  for(let i=0;i<10 && !f.modules;i++) await tick();
  assert.equal(f.modules,1);
  assert.equal(f.timers.size,1);
  [...f.timers.values()][0](); await starting;
  assert.equal(f.stopped,1);
  assert.equal(f.timers.size,0);
  assert.equal(f.element('voiceStatus').textContent,'录音初始化超时，请重试或改用文字提问');
  assert.equal(f.connections[0].sent.some(m=>m.type==='audio.start'),false);
  f.module.resolve(); await tick();
  assert.equal(f.stopped,1);
  f.select(2);
});
