(function(){
  'use strict';
  const PROFILE_KEY='careerfly-campus-profile-v1';
  const text=(value,max)=>typeof value==='string'&&value.length<=max;
  function validProfile(value){
    if(!value||value.version!==1||!text(value.updatedAt,40)||!Number.isFinite(Date.parse(value.updatedAt)))return false;
    if(!Array.isArray(value.entries)||value.entries.length!==8||!value.entries.every(e=>e&&text(e.name,40)&&text(e.value,600)&&text(e.note,800)))return false;
    if(!Array.isArray(value.directions)||value.directions.length!==3||!value.directions.every(d=>d&&text(d.name,80)&&Number.isInteger(d.percent)&&d.percent>=0&&d.percent<=100))return false;
    return text(value.action,500);
  }
  if(typeof module==='object'&&module.exports)module.exports={validProfile};
  if(typeof document==='undefined')return;
  const frame=document.getElementById('campusAssessmentFrame');
  if(!frame)return;
  const status=document.getElementById('assessmentSaveStatus');
  let attempt='',currentProfile=null,pending=false;
  // 在宿主页接管接待入口，保留游戏原稿及其画像确认交互。
  frame.addEventListener('load',()=>{
    const gameDocument=frame.contentDocument;
    const loadedAttempt=new URL(frame.contentWindow.location.href).searchParams.get('attempt');
    if(!gameDocument||!attempt||loadedAttempt!==attempt)return;
    gameDocument.addEventListener('click',event=>{
      const button=event.target.closest?.('#expert');
      if(!button||loadedAttempt!==attempt||gameDocument!==frame.contentDocument)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if(button.disabled||!gameDocument.getElementById('consent')?.checked)return;
      const expertIndex=experts.findIndex(expert=>expert.voiceId==='robin-li');
      if(expertIndex<0){status.textContent='暂时无法打开专家详情，请稍后重试';return;}
      openExpertDetail(expertIndex);
    },true);
  });
  function renderProfile(profile){
    currentProfile=profile;
    for(const id of ['campusResultHome','campusResultDetail']){
      const host=document.getElementById(id);if(!host)continue;
      host.replaceChildren();
      if(!profile&&!pending)continue;
      const details=document.createElement('details'),summary=document.createElement('summary');
      summary.textContent=profile?'我的游戏化测评结果 · 单独保存的个人线索':'你的校园探索，正要开始 · 完成后在此查看';
      details.append(summary);
      if(profile){
        const description=document.createElement('p');description.textContent='值得探索：'+profile.directions.map(d=>d.name).join('、')+'。'+profile.action;details.append(description);
        const list=document.createElement('ul');profile.entries.forEach(e=>{const li=document.createElement('li');li.textContent=e.name+'：'+e.value+' — '+e.note;list.append(li)});details.append(list);
        const note=document.createElement('p');note.textContent='以上是你的测评线索；示例档案与 RIASEC 演示分数保持独立，任务记录不改变兴趣分数。';details.append(note);
      }
      host.append(details);
    }
  }
  window.renderCampusAssessmentResult=()=>renderProfile(currentProfile);
  try{
    const saved=JSON.parse(localStorage.getItem(PROFILE_KEY));
    if(validProfile(saved))renderProfile(saved);
    else if(saved?.pending===true){pending=true;renderProfile(null);}
  }catch{}
  window.startCareerAssessment=function(entry='update'){
    attempt=window.crypto?.randomUUID?.()||Date.now()+'-'+Math.random().toString(36).slice(2);
    if(entry==='register'){
      pending=true;renderProfile(null);
      try{localStorage.setItem(PROFILE_KEY,JSON.stringify({pending:true}))}catch{}
    }
    status.textContent='校园职业探索 · 六站测评';
    frame.src='/static/campus-assessment.html?attempt='+encodeURIComponent(attempt);
    showPage('assessment');
  };
  document.getElementById('assessmentBack').addEventListener('click',()=>{
    showPage('my');
    document.querySelector('#my [data-ws-page=\"myCareerProfile\"]')?.focus({preventScroll:true});
  });
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==frame.contentWindow)return;
    const data=event.data;
    if(data?.type!=='careerfly:assessment-complete'||!attempt||data.attempt!==attempt||!validProfile(data.profile))return;
    renderProfile(data.profile);
    try{
      localStorage.setItem(PROFILE_KEY,JSON.stringify(data.profile));
      status.textContent='职业画像已更新 · 返回主页即可查看';
    }catch{
      status.textContent='本次画像已更新；浏览器无法保存，关闭页面后将丢失';
    }
  });
})();
