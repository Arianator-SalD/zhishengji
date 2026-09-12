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
  const card=document.querySelector('#careerProfileCard .careerbox');
  let attempt='';
  function renderProfile(profile){
    if(!card)return;
    const tags=card.querySelector('.strengths');
    tags.replaceChildren();
    if(!profile){
      card.querySelector('h2').textContent='你的校园探索，正要开始';
      card.querySelector('p').textContent='完成六站游戏化测评后，这里会展示你的兴趣线索与候选职业方向。';
      card.querySelector('.quote').textContent='点击“更新职业画像”，开始一段新的校园故事。';
      return;
    }
    card.querySelector('h2').textContent='值得探索：'+profile.directions.map(d=>d.name).join('、');
    profile.entries.slice(0,2).forEach(entry=>{const tag=document.createElement('span');tag.textContent=entry.value;tags.append(tag)});
    card.querySelector('p').textContent=profile.action;
    card.querySelector('.quote').textContent='来自本次测评的兴趣与价值取舍，作为探索线索；能力与岗位适配仍需进一步验证。';
  }
  try{
    const saved=JSON.parse(localStorage.getItem(PROFILE_KEY));
    if(validProfile(saved))renderProfile(saved);
    else if(saved?.pending===true)renderProfile(null);
  }catch{}
  window.startCareerAssessment=function(entry='update'){
    attempt=window.crypto?.randomUUID?.()||Date.now()+'-'+Math.random().toString(36).slice(2);
    if(entry==='register'){
      renderProfile(null);
      try{localStorage.setItem(PROFILE_KEY,JSON.stringify({pending:true}))}catch{}
    }
    status.textContent='校园职业探索 · 六站测评';
    frame.src='/static/campus-assessment.html?attempt='+encodeURIComponent(attempt);
    showPage('assessment');
  };
  document.getElementById('updateCareerProfile').addEventListener('click',()=>window.startCareerAssessment('update'));
  document.getElementById('assessmentBack').addEventListener('click',()=>{
    showPage('my');
    document.getElementById('updateCareerProfile').focus({preventScroll:true});
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
