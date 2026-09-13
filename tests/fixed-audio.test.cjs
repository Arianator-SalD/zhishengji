const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const tick = () => new Promise(setImmediate);

async function setup({playFailure = false, delayedPlay = false} = {}) {
  const elements = new Map(), sockets = [], audios = [], states = [], bubbles = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value:'', textContent:'', dataset:{}, classList:{toggle(){}}, append(){}});
    return elements.get(id);
  };
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState=1;this.sent=[];sockets.push(this);setImmediate(()=>this.onopen?.()); }
    send(raw) {
      const m=JSON.parse(raw);this.sent.push(m);
      if(m.type==='session.start')setImmediate(()=>this.emit({type:'session.ready'}));
    }
    emit(m) { this.onmessage?.({data:JSON.stringify(m)}); }
    close() { this.readyState=3;this.onclose?.(); }
  }
  class Media {
    constructor(url) { this.url=url;this.paused=true;audios.push(this); }
    play() {
      this.paused=false;
      if(playFailure)return Promise.reject(new Error('blocked'));
      if(delayedPlay)return new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});
      setImmediate(()=>this.onplaying?.());return Promise.resolve();
    }
    pause() {this.paused=true;}
    removeAttribute() {this.removed=true;}
    load() {this.cancelled=true;}
    end() {this.paused=true;this.onended?.();}
  }
  // Native media must work without scheduling any PCM buffer sources.
  class Context { constructor(){this.state='running';}createBufferSource(){throw new Error('Unexpected PCM scheduling');} }
  const win={addEventListener(){},zhijianUI:{
    state(value,info){states.push({value,...info});},clear(){},memory(){},
    bubble(){const node={textContent:'',append(){}};bubbles.push(node);return node;}
  }};
  const ctx=vm.createContext({window:win,document:{getElementById:element},
    selectedExpert:0,experts:[{voiceId:'sally'},{voiceId:'robin-li'},{name:'mock'}],
    location:{protocol:'http:',host:'test.invalid'},WebSocket:Socket,Audio:Media,AudioContext:Context,
    crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,
    fetch:async url=>({ok:true,json:async()=>({expert_id:new URL(url,'http://test.invalid').searchParams.get('expert_id'),
      capabilities:{llm:true,asr:true,tts:false},fixed_audio:true,qa:[],profile:{}})}),
    questionSets:[],renderSuggestedQuestions(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/voice.js'),'utf8'),ctx);
  await tick();
  const send=async()=>{element('voiceTextInput').value='固定问题';await element('voiceTextSend').onclick();return sockets.at(-1);};
  const message=(socket,overrides={})=>({type:'audio.file',turn_id:'turn-1',segment_id:0,
    request_id:socket.sent.findLast(m=>m.type==='input.text').request_id,
    url:'/static/fixed-audio/sally-fixed-finance-to-product-abcdef123456.wav',...overrides});
  const select=i=>{ctx.selectedExpert=i;win.zhijianVoice.select(i);};
  return {element,sockets,audios,states,bubbles,win,send,message,select,cleanup(){select(2);}};
}

test('fixed file works without live TTS; only an actual ended event acknowledges it once',async()=>{
  const f=await setup();const socket=await f.send(),m=f.message(socket);
  assert.equal(socket.sent.find(m=>m.type==='input.text').speak,true);
  socket.emit(m);socket.emit({...m,type:'turn.end'});await tick();
  assert.equal(f.audios.length,1);
  assert.equal(f.states.at(-1).busy,true);
  assert.equal(socket.sent.some(m=>m.type==='playback.ack'),false);
  socket.emit(m);assert.equal(f.audios.length,1);
  f.audios[0].end();socket.emit(m);
  assert.equal(socket.sent.filter(m=>m.type==='playback.ack').length,1);
  assert.equal(f.audios.length,1);assert.equal(f.states.at(-1).busy,false);
  f.cleanup();
});

test('hangup cancels a pending play and ignores its late rejection and completion',async()=>{
  const f=await setup({delayedPlay:true}),socket=await f.send();socket.emit(f.message(socket));
  const audio=f.audios[0],ended=audio.onended;
  f.win.zhijianVoice.close('callModal');
  assert.equal(audio.paused,true);assert.equal(audio.cancelled,true);
  audio.reject(new Error('late cancelled'));ended();await tick();
  assert.equal(socket.sent.some(m=>m.type==='playback.ack'),false);
  assert.equal(f.element('voiceStatus').textContent,'已停止，可以继续提问');
  f.cleanup();
});

test('switching experts stops audio and stale socket events cannot restart it',async()=>{
  const f=await setup(),socket=await f.send(),m=f.message(socket);socket.emit(m);await tick();
  const old=f.audios[0],ended=old.onended;f.select(1);await tick();
  assert.equal(old.paused,true);assert.equal(old.cancelled,true);
  ended();socket.emit(m);assert.equal(f.audios.length,1);
  assert.equal(socket.sent.some(m=>m.type==='playback.ack'),false);
  const robin=await f.send();robin.emit(f.message(robin,{url:'/static/fixed-audio/robin-li-fixed-ai-non-consensus-abcdef123456.wav'}));
  await tick();assert.equal(f.audios.length,2);f.cleanup();
});

test('load or autoplay failure retains text, reports inline, and never acknowledges',async()=>{
  const f=await setup({playFailure:true}),socket=await f.send(),m=f.message(socket);
  socket.emit(m);socket.emit({...m,type:'turn.end'});await tick();
  assert.match(f.element('voiceStatus').textContent,/固定语音未能播放/);
  assert.equal(f.states.at(-1).busy,false);
  assert.equal(socket.sent.some(m=>m.type==='playback.ack'),false);
  assert.equal(f.audios[0].cancelled,true);f.cleanup();
});

test('wrong request and wrong expert asset are never played',async()=>{
  const f=await setup(),socket=await f.send();
  socket.emit(f.message(socket,{request_id:'stale'}));assert.equal(f.audios.length,0);
  socket.emit(f.message(socket,{url:'/static/fixed-audio/robin-li-fixed-ai-non-consensus-abcdef123456.wav'}));
  assert.equal(f.audios.length,0);assert.match(f.element('voiceStatus').textContent,/未能播放/);f.cleanup();
});

test('if the file ends before text delivery finishes, the turn stays busy until turn.end',async()=>{
  const f=await setup(),socket=await f.send(),m=f.message(socket);
  socket.emit({...m,type:'reply.delta',text:'前三字'});socket.emit(m);await tick();
  f.audios[0].end();
  assert.equal(socket.sent.filter(m=>m.type==='playback.ack').length,1);
  assert.equal(f.states.at(-1).busy,true);
  socket.emit({...m,type:'reply.delta',text:'后续固定文字'});
  socket.emit({...m,type:'turn.end'});
  assert.equal(f.states.at(-1).busy,false);f.cleanup();
});

test('audio failure after the first delta still allows the full fixed copy to finish streaming',async()=>{
  const f=await setup({playFailure:true}),socket=await f.send(),m=f.message(socket);
  socket.emit({...m,type:'reply.delta',text:'固定回'});
  socket.emit(m);await tick();
  assert.equal(f.states.at(-1).busy,true);
  socket.emit({...m,type:'reply.delta',text:'答的完整内容。'});
  socket.emit({...m,type:'turn.end'});
  assert.deepEqual(f.bubbles.slice(-2).map(b=>b.textContent),['固定回答的完整内容。','固定回答的完整内容。']);
  assert.equal(f.states.at(-1).busy,false);
  assert.match(f.element('voiceStatus').textContent,/固定语音未能播放/);
  assert.equal(socket.sent.some(m=>m.type==='playback.ack'),false);f.cleanup();
});
