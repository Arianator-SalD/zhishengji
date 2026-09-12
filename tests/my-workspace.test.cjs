const {test}=require("node:test");
const assert=require("node:assert/strict");
const D=require("../static/my-workspace-data.js");
test("eight weeks budget learning, practice and review within 240 minutes",()=>{
  assert.equal(D.categories.length,7);assert.equal(D.weeks.length,8);
  for(let w=1;w<=8;w++)assert.equal(D.tasks.filter(t=>t.week===w).reduce((n,t)=>n+t.minutes,0),240,`week ${w}`);
  assert.equal(new Set(D.tasks.map(t=>t.id)).size,D.tasks.length);
  for(const t of D.tasks){assert.ok(D.categories.some(c=>c.id===t.category));for(const key of ["gap","why","precondition","resources","deliverable","feedback","alternative"])assert.ok(t[key]);assert.ok(t.steps.length>=3);}
});
test("initial sample is a student; first week has three primary tasks, buffer is not fourth task",()=>{
  const s=D.initialState();assert.equal(s.profile.internship,"暂无正式实习");assert.equal(s.profile.hours,4);
  assert.deepEqual(D.stats(s),{total:3,done:1,doing:1,pending:1});
  assert.equal(s.tasks["w1-1"].count,5);assert.equal(s.tasks["w1-2"].count,1);
  assert.ok(D.tasks.filter(t=>t.week>1).every(t=>s.tasks[t.id].status==="pending"));
});
test("round trip persists tasks and evidence without changing the fixed RIASEC data",()=>{
  const scores=D.interest.map(d=>[d.id,d.score]);assert.deepEqual(scores,[["R",35],["I",80],["A",65],["S",75],["E",85],["C",55]]);
  const s=D.initialState();D.updateTask(s,"w1-2",{status:"done",count:2,record:"三份匿名记录",feedback:"继续追问场景"});
  s.interestFeedback.push({week:1,liked:"喜欢提问",direction:"继续探索"});s.evidence.push({title:"课程作业",content:"本人贡献"});
  const loaded=D.restore(JSON.parse(JSON.stringify(s)));
  assert.equal(loaded.tasks["w1-2"].count,3);assert.equal(loaded.tasks["w1-2"].record,"三份匿名记录");assert.deepEqual(D.stats(loaded),{total:3,done:2,doing:0,pending:1});assert.deepEqual(D.interest.map(d=>[d.id,d.score]),scores);
  assert.equal(loaded.evidence.length,1);assert.equal(loaded.interestFeedback.length,1);
});
test("old professional-case state and malformed saved state cannot overwrite the student sample",()=>{
  assert.deepEqual(D.restore({"rewrite-project":true}),D.initialState());
  const s=D.restore({version:2,values:[0,0,2],tasks:{"w1-2":{status:"unknown",count:-22,scheduledWeek:500,plannedMinutes:-30}},profile:{hours:Infinity}});
  assert.deepEqual(s.values,[0,1,2]);assert.equal(s.tasks["w1-2"].scheduledWeek,1);assert.equal(s.tasks["w1-2"].plannedMinutes,90);assert.equal(s.tasks["w1-2"].count,0);assert.ok(s.profile.hours<=40);
});
test("rescheduling changes grouped totals while preserving original task data and progress",()=>{
  const s=D.initialState();s.tasks["w1-2"].scheduledWeek=2;s.tasks["w1-2"].plannedMinutes=60;
  const restored=D.restore(JSON.parse(JSON.stringify(s)));
  assert.equal(D.stats(restored).total,2);assert.equal(D.stats(restored,2).doing,1);
  assert.equal(D.tasks.find(t=>t.id==="w1-2").minutes,90);assert.equal(restored.tasks["w1-2"].plannedMinutes,60);
});
