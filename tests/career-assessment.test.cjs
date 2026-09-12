const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../static/career-assessment.js'),'utf8');
const {validProfile}=require('../static/career-assessment.js');
const sample=()=>({version:1,updatedAt:'2026-09-13T00:00:00Z',entries:Array.from({length:8},(_,i)=>({name:'线索'+i,value:'自述偏好',note:'待验证'})),directions:[{name:'产品助理',percent:22},{name:'数据分析',percent:18},{name:'运营',percent:16}],action:'试一次校园项目'});
function harness(){
  const listeners={},values=new Map(),nodes={};
  const node=()=>({textContent:'',children:[],addEventListener(type,fn){this[type]=fn},replaceChildren(){this.children=[]},append(n){this.children.push(n)},focus(){}});
  for(const id of ['campusAssessmentFrame','assessmentSaveStatus','updateCareerProfile','assessmentBack','campusResultHome','campusResultDetail'])nodes[id]=node();
  nodes.campusAssessmentFrame.contentWindow={};
  const fields=Object.fromEntries(['h2','p','.quote','.strengths'].map(k=>[k,node()]));
  let page='',count=0;
  const context={URL,experts:[{voiceId:'sally'},{name:'演示专家'},{voiceId:'robin-li'}],openExpertDetail:index=>{context.selectedExpert=index;page='expertDetail';},document:{getElementById:id=>nodes[id],querySelector:()=>({querySelector:key=>fields[key],focus(){}}),createElement:node},window:{crypto:{randomUUID:()=>String(++count)},addEventListener:(type,fn)=>listeners[type]=fn},location:{origin:'https://app.test'},localStorage:{getItem:key=>values.get(key)||null,setItem:(key,v)=>values.set(key,v)},showPage:id=>page=id};
  vm.runInNewContext(source,context);
  return {context,nodes,values,fields,page:()=>page,send(data,extra={}){listeners.message({origin:context.location.origin,source:nodes.campusAssessmentFrame.contentWindow,data,...extra})}};
}
test('profile import rejects malformed, incomplete and oversize results',()=>{
  assert.equal(validProfile(sample()),true);
  for(const p of [null,{}, {...sample(),entries:[]},{...sample(),updatedAt:'invalid'},{...sample(),action:'x'.repeat(501)},{...sample(),directions:[{name:'test',percent:Infinity}]}])assert.equal(validProfile(p),false);
});
function loadGame(h,attempt='1'){
  const consent={checked:false},button={disabled:true};
  const game={getElementById:id=>id==='consent'?consent:null,addEventListener(type,fn,capture){assert.equal(capture,true);this[type]=fn;}};
  const frame=h.nodes.campusAssessmentFrame;
  frame.contentDocument=game;
  frame.contentWindow.location={href:'https://app.test/static/campus-assessment.html?attempt='+attempt};
  frame.load();
  return {consent,button,click(){const event={target:{closest:selector=>selector==='#expert'?button:null},preventDefault(){this.prevented=true},stopImmediatePropagation(){this.stopped=true}};game.click?.(event);return event;}};
}
test('confirmed game entry opens Robin detail and preserves the saved profile',()=>{
  const h=harness();h.context.window.startCareerAssessment('register');
  h.send({type:'careerfly:assessment-complete',attempt:'1',profile:sample()});
  const saved=h.values.get('careerfly-campus-profile-v1'),game=loadGame(h);
  game.click();assert.equal(h.page(),'assessment');
  game.button.disabled=false;game.click();assert.equal(h.page(),'assessment');
  game.consent.checked=true;
  const event=game.click();
  assert.equal(h.page(),'expertDetail');
  assert.equal(h.context.experts[h.context.selectedExpert].voiceId,'robin-li');
  assert.equal(event.stopped,true);
  assert.equal(h.values.get('careerfly-campus-profile-v1'),saved);
});
test('a previous game document cannot navigate after a new attempt starts',()=>{
  const h=harness();h.context.window.startCareerAssessment();
  const old=loadGame(h);old.button.disabled=false;old.consent.checked=true;
  h.context.window.startCareerAssessment();old.click();
  assert.equal(h.page(),'assessment');
  const stale=loadGame(h,'1');stale.button.disabled=false;stale.consent.checked=true;stale.click();
  assert.equal(h.page(),'assessment');
  const current=loadGame(h,'2');current.button.disabled=false;current.consent.checked=true;current.click();
  assert.equal(h.page(),'expertDetail');
});
test('only this iframe and active attempt may update the separate assessment result',()=>{
  const h=harness();h.context.window.startCareerAssessment('update');
  const message={type:'careerfly:assessment-complete',attempt:'1',profile:sample()};
  h.send(message,{origin:'https://other.test'});h.send(message,{source:{}});h.send({...message,attempt:'older'});
  assert.equal(h.values.size,0);
  h.send(message);
  assert.match(h.nodes.campusResultHome.children[0].children[1].textContent,/产品助理/);
  assert.equal(h.fields.h2.textContent,''); // assessment never overwrites the student demo radar or profile
  assert.match(h.nodes.assessmentSaveStatus.textContent,/已更新/);
  assert.equal(JSON.parse(h.values.get('careerfly-campus-profile-v1')).action,'试一次校园项目');
});
test('retake opens a new attempt, keeps the last completed result, and returns to my page',()=>{
  const h=harness();h.context.window.startCareerAssessment('update');
  h.send({type:'careerfly:assessment-complete',attempt:'1',profile:sample()});
  const previous=h.values.get('careerfly-campus-profile-v1');
  h.context.window.startCareerAssessment('update');
  assert.equal(h.page(),'assessment');
  assert.match(h.nodes.campusAssessmentFrame.src,/attempt=2$/);
  assert.equal(h.values.get('careerfly-campus-profile-v1'),previous);
  h.send({type:'careerfly:assessment-complete',attempt:'1',profile:{...sample(),action:'stale'}});
  assert.equal(h.values.get('careerfly-campus-profile-v1'),previous);
  h.nodes.assessmentBack.click();assert.equal(h.page(),'my');
  h.context.window.startCareerAssessment('register');
  assert.equal(JSON.parse(h.values.get('careerfly-campus-profile-v1')).pending,true);
  assert.match(h.nodes.campusResultHome.children[0].children[0].textContent,/正要开始/);
});
