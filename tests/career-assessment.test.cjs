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
  for(const id of ['campusAssessmentFrame','assessmentSaveStatus','updateCareerProfile','assessmentBack'])nodes[id]=node();
  nodes.campusAssessmentFrame.contentWindow={};
  const fields=Object.fromEntries(['h2','p','.quote','.strengths'].map(k=>[k,node()]));
  let page='',count=0;
  const context={document:{getElementById:id=>nodes[id],querySelector:()=>({querySelector:key=>fields[key]}),createElement:node},window:{crypto:{randomUUID:()=>String(++count)},addEventListener:(type,fn)=>listeners[type]=fn},location:{origin:'https://app.test'},localStorage:{getItem:key=>values.get(key)||null,setItem:(key,v)=>values.set(key,v)},showPage:id=>page=id};
  vm.runInNewContext(source,context);
  return {context,nodes,values,fields,page:()=>page,send(data,extra={}){listeners.message({origin:context.location.origin,source:nodes.campusAssessmentFrame.contentWindow,data,...extra})}};
}
test('profile import rejects malformed, incomplete and oversize results',()=>{
  assert.equal(validProfile(sample()),true);
  for(const p of [null,{}, {...sample(),entries:[]},{...sample(),updatedAt:'invalid'},{...sample(),action:'x'.repeat(501)},{...sample(),directions:[{name:'test',percent:Infinity}]}])assert.equal(validProfile(p),false);
});
test('only this iframe and active attempt may update the homepage profile',()=>{
  const h=harness();h.context.window.startCareerAssessment('update');
  const message={type:'careerfly:assessment-complete',attempt:'1',profile:sample()};
  h.send(message,{origin:'https://other.test'});h.send(message,{source:{}});h.send({...message,attempt:'older'});
  assert.equal(h.values.size,0);
  h.send(message);
  assert.match(h.fields.h2.textContent,/产品助理/);
  assert.match(h.nodes.assessmentSaveStatus.textContent,/已更新/);
  assert.equal(JSON.parse(h.values.get('careerfly-campus-profile-v1')).action,'试一次校园项目');
});
test('retake opens a new attempt, keeps the last completed result, and returns to my page',()=>{
  const h=harness();h.context.window.startCareerAssessment('update');
  h.send({type:'careerfly:assessment-complete',attempt:'1',profile:sample()});
  const previous=h.values.get('careerfly-campus-profile-v1');
  h.nodes.updateCareerProfile.click();
  assert.equal(h.page(),'assessment');
  assert.match(h.nodes.campusAssessmentFrame.src,/attempt=2$/);
  assert.equal(h.values.get('careerfly-campus-profile-v1'),previous);
  h.send({type:'careerfly:assessment-complete',attempt:'1',profile:{...sample(),action:'stale'}});
  assert.equal(h.values.get('careerfly-campus-profile-v1'),previous);
  h.nodes.assessmentBack.click();assert.equal(h.page(),'my');
  h.context.window.startCareerAssessment('register');
  assert.equal(JSON.parse(h.values.get('careerfly-campus-profile-v1')).pending,true);
  assert.match(h.fields.h2.textContent,/正要开始/);
});
