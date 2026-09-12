/* One demo case; immutable interest scores are separate from evidence and action progress. */
(function(root){
  "use strict";
  const profile={name:"林小北",school:"上海某高校",degree:"本科",grade:"大三",major:"信息管理与信息系统",graduation:"2028 届",internship:"暂无正式实习",stage:"职业探索·首次实习准备",direction:"产品经理",comparison:"用户运营",city:"上海",hours:4,intention:"2027 年寒假第一段实习",availability:"到岗日期、每周到岗天数和持续时间待与课表及岗位要求核对",signature:"从校园里的一个小问题，开始探索自己的职业方向。",dilemma:"我喜欢研究一个功能为什么不好用，但不知道自己更适合做产品还是运营，也不知道没有实习能从哪里开始。"};
  const interest=[
    ["R","实际型",35,"Realistic","动手操作、工具设备、制作维修、户外实践"],
    ["I","研究型",80,"Investigative","分析问题、调查研究、探索原因"],
    ["A","艺术型",65,"Artistic","创意表达、设计、写作与开放式创作"],
    ["S","社会型",75,"Social","帮助、教导、支持与服务他人"],
    ["E","企业型",85,"Enterprising","发起活动、说服协调、组织推动"],
    ["C","常规型",55,"Conventional","组织资料、按规则处理信息、维护流程"]
  ].map(([id,name,score,english,description])=>({id,name,score,english,description}));
  const values=[{name:"成就与成长",description:"希望做完事情后能看见自己的进步。"},{name:"组织支持",description:"希望有人愿意指导新人、提供具体反馈。"},{name:"人际关系",description:"重视友好、开放、愿意交流的协作氛围。"}];
  const experiences=[{name:"课程调研",topic:"校园活动参与情况",contribution:"整理 24 份问卷、完成基础描述统计、参与小组汇报。",supports:"信息整理、初步数据处理、表达",missing:"作业附件、个人负责部分、教师或同伴反馈"},{name:"社团招新",topic:"招新报名与说明会",contribution:"与 2 名同学整理报名信息、收集常见问题、协助组织说明会。",supports:"同伴协作、信息沟通",missing:"分工记录、活动材料、同伴反馈"}];
  const categories=[
    ["self","自我探索与方向验证","确认自己是否愿意持续做这类任务。","产品与运营方向比较、体验感受和选择理由。"],
    ["jobs","岗位认知与信息核实","了解工作日常和入门要求。","岗位对照表、请教问题、交流纪要。"],
    ["learn","能力学习与专项练习","围绕当前缺口学习。","访谈练习、数据练习、流程与原型练习。"],
    ["project","项目实践与作品积累","围绕一个校园问题完成实践。","访谈记录、问题定义、原型、测试与复盘。"],
    ["materials","求职材料与表达准备","讲清已有经历和个人贡献。","简历、项目讲述稿、模拟面试反馈。"],
    ["support","支持网络与机会获取","获得具体反馈，找到符合条件的机会。","反馈记录、机会清单、投递及跟进记录。"],
    ["review","复盘与计划调整","根据体验、证据和时间变化调整方向。","每周复盘、画像更新和下一步计划。"]
  ].map(([id,name,goal,outcome])=>({id,name,goal,outcome}));
  const weeks=[
    ["了解岗位、发现问题","5 份岗位对照、3 份探索记录、1 页问题与证据"],
    ["进一步确认问题","共 5 份探索记录、一个值得继续研究的问题、方向比较记录"],
    ["表达解决方案","一个关键流程、3–5 个原型页面、一页方案说明"],
    ["测试与修改","测试观察、修改前后版本、仍待验证的问题"],
    ["学习数据与验证方法","数据练习、一个核心指标的定义、后续验证办法"],
    ["整理项目案例","包含问题、证据、个人贡献、方案与局限的项目案例"],
    ["准备实习材料","一页简历、3 分钟项目讲述、符合实际条件的机会清单"],
    ["尝试机会并复盘方向","面试改进记录、投递或后续开放时间记录、下一阶段选择"]
  ].map(([name,outcome],i)=>({week:i+1,name,outcome}));
  // title, minutes, category, deliverable, concrete workflow. Learning and review are included in 240 minutes.
  const schedule=[
    [["看懂产品与运营的工作差别",45,"jobs","5 份岗位对照：3 份产品、2 份运营，记录日常任务和主要要求。","收集岗位说明→标注任务与要求→区分产品和运营→记录待核实问题"],["完成 3 位同学的探索访谈",90,"project","3 份匿名访谈记录；每份包含具体场景、行为、困难及原话。","准备提纲→约同学→每人交流约 15 分钟→匿名整理→区分事实和解释"],["整理 1 页问题与证据",45,"project","1 页问题与证据：谁在什么场景遇到什么问题，哪些想法还需验证。","汇总访谈→区分事实与推测→写清场景与困难→标注证据不足"],["反馈与缓冲",60,"review","一条具体反馈与本周调整记录。","邀请同伴反馈→整理遗漏→记录本周感受与时间变化"]],
    [["整理已有材料",30,"project","一份问卷与访谈材料索引。","收集材料→匿名编号→标注出处与缺口"],["补访 2 人及整理",90,"project","新增 2 份匿名访谈，累计 5 份探索记录。","按缺口选人→追问具体经历→整理原话与困难"],["界定问题与优先级",60,"project","一个值得继续研究的问题及选择依据。","归类困难→比较频次与影响→写出取舍和局限"],["比较产品与运营工作偏好",30,"self","一份两类工作偏好对照与原因。","回顾岗位任务→记录喜欢与不喜欢→标注仍需体验部分"],["每周复盘",30,"review","完成情况、兴趣反馈、困难与下一周安排。","回顾成果→记录体验→核对下周时间→选择继续或调整"]],
    [["工具入门",60,"learn","一份工具练习与操作记录。","选择纸笔或原型工具→学习基本操作→练习页面连接"],["关键流程与低保真原型",120,"project","一个关键流程与 3–5 个低保真页面。","确定核心任务→画流程→画页面→自查是否能走通"],["简版需求说明",30,"project","一页方案说明，含问题、使用者、流程与边界。","引用问题证据→描述方案→说明取舍与未解决部分"],["每周复盘",30,"review","本周体验与下周调整记录。","核对交付物→记录设计体验→安排测试"]],
    [["准备测试任务",30,"learn","不暗示答案的测试任务与观察表。","选择关键路径→写任务情境→准备观察字段"],["3 位同学测试及整理",90,"project","3 份匿名测试观察，区分观察和解释。","邀请同学→观察独立完成→记录卡点→询问原因"],["修改方案",90,"project","修改前后版本及仍待验证的问题。","整理卡点→选择优先问题→修改原型→说明原因"],["每周复盘",30,"review","测试体验、剩余问题与下一步。","核对证据→记录喜欢和困难→调整后续安排"]],
    [["指标学习",45,"learn","一份指标定义与使用边界笔记。","区分行为与结果→学习分子分母→举校园例子"],["Excel 或 SQL 练习",90,"learn","一份练习文件和过程说明，标注模拟数据。","选匿名示例数据→筛选汇总→核对结果→记录错误"],["为方案设计验证指标",75,"project","一个核心指标的定义与后续验证办法。","确定目标→定义指标和口径→说明采集方法与限制"],["每周复盘",30,"review","数据练习心得与待补问题。","核对结果→记录工具体验→调整下一周"]],
    [["整理案例",90,"materials","包含问题、证据、个人贡献、方案和局限的案例草稿。","整理材料→标注个人贡献→连接证据与方案→写局限"],["获取同伴反馈并修改",90,"support","同伴反馈与案例修订记录。","邀请阅读→请对方指出不清楚处→修改→保留反馈依据"],["准备请教学长的问题",30,"jobs","一份针对项目和实习日常的请教问题。","列疑惑→查已有信息→挑选三个具体问题"],["每周复盘",30,"review","对案例与支持资源的复盘。","回顾反馈→确认缺口→安排材料准备"]],
    [["简历草稿",90,"materials","一页首份实习简历，不虚构企业经历或商业成果。","列学校与校园经历→写个人贡献→附作品入口→检查事实"],["核查机会与到岗条件",60,"support","标注到岗日期、天数、持续时间的机会清单。","查学校渠道→核对岗位要求与课表→记录待确认条件"],["练习项目讲述",60,"materials","3 分钟项目讲述和一条反馈。","按问题证据方案复盘组织→计时讲述→请同伴反馈→调整"],["每周复盘",30,"review","材料完成情况与机会约束记录。","核查事实→记录表达体验→确定下周可用时间"]],
    [["模拟面试",60,"materials","一次模拟面试反馈及待改进点。","请同伴提问→讲述项目→回答取舍→收集具体反馈"],["根据反馈修改",60,"materials","修订简历或案例及改动说明。","选关键反馈→核对依据→修改→再检查表达"],["筛选并尝试合适机会",90,"support","投递及跟进记录，或岗位后续开放时间记录。","核对资格和到岗→选择机会→自行投递或记开放时间→安排跟进"],["方向复盘",30,"self","基于实际体验的下一阶段方向选择。","比较喜欢的任务→引用经历证据→说明继续或调整原因"]]
  ];
  const gaps={jobs:"产品与运营日常及岗位要求待核实",project:"需求探索、方案设计和测试尚待体验",learn:"访谈方法、原型工具、SQL 与效果验证待练习",materials:"首份实习材料与个人贡献表达待积累",support:"缺少项目反馈与到岗信息",self:"方向偏好需要实际体验验证",review:"需要把反馈转成下一步安排"};
  const tasks=schedule.flatMap((rows,w)=>rows.map(([title,minutes,category,deliverable,steps],i)=>({id:`w${w+1}-${i+1}`,week:w+1,title,minutes,category,deliverable,steps:steps.split("→"),gap:gaps[category],why:categories.find(c=>c.id===category).goal,direction:category==="self"||category==="jobs"?"产品经理 / 用户运营":"产品经理",priority:i===0?"优先":"常规",precondition:w===0&&i===2?"完成探索访谈":w===0?"无，按步骤开始":`参考第 ${w} 周成果；材料不足时先补充证据`,resources:category==="support"?"学校就业渠道、同伴或学长；发送请教或投递需本人操作":"课程材料、匿名记录、纸笔或文档工具；可向同伴请教",alternative:category==="project"?"约不到人时先整理已有材料，标注证据不足，将剩余工作顺延。":"考试或时间不匹配时先做 30–60 分钟整理复盘，其余顺延；不可把未做内容标为完成。",feedback:"请同伴指出一处不清楚的内容，并记录下一步如何修改。",buffer:w===0&&i===3,total:w===0?(i===0?5:i===1?3:1):1})));
  Object.assign(tasks[1],{why:"了解校园活动报名中的具体困难，验证问题是否存在。",gap:"尚未体验真实需求访谈",resources:"3 位愿意分享经历的同学、访谈提纲、匿名记录模板；90 分钟包含准备和整理。",alternative:"若本周只能约到 1 人，先整理已有记录并标注证据不足，剩余任务顺延。"});
  const goal="用 8 周完成一次校园产品小实践，为第一段实习做准备。";
  const summary="你在课程调研中整理过同学问卷，也参与过社团招新协作。这些经历可以成为探索产品工作的起点。目前，你还需要体验需求访谈、方案设计和用户测试，才能更清楚地判断自己是否喜欢这类工作。建议先从一个校园问题做起，积累第一份产品实践作品。";
  const advice="先找一个你在校园里观察到的小问题，听听真正遇到它的人怎么说。做完一次小尝试，再决定要不要继续走产品方向。";
  const consultation={name:"产品方向 AI 顾问",question:"没有实习经历的大三学生，怎样判断自己适不适合产品经理？",summary:"从课程调研和社团经历梳理已有基础；先完成一次校园问题探索，再比较自己对需求分析、方案设计与用户沟通的兴趣。",result:"已生成本周 3 项探索任务。"};
  function initialState(){return {version:2,profile:{...profile},values:[0,1,2],tasks:Object.fromEntries(tasks.map(t=>[t.id,{status:t.id==="w1-1"?"done":t.id==="w1-2"?"doing":"pending",count:t.id==="w1-1"?5:t.id==="w1-2"?1:0,record:"",feedback:"",scheduledWeek:t.week,plannedMinutes:t.minutes,arrangement:""}])),evidence:[],interestFeedback:[],reviews:[],adjustments:[]};}
  function updateTask(state,id,patch){const t=tasks.find(x=>x.id===id);if(!t)throw Error("未知任务");const previous=state.tasks[id];const status=["pending","doing","done"].includes(patch.status)?patch.status:previous.status;const count=status==="done"?t.total:status==="pending"?0:Math.min(t.total-1,Math.max(0,Number(patch.count)||0));state.tasks[id]={...previous,status,count,record:String(patch.record??previous.record).slice(0,8000),feedback:String(patch.feedback??previous.feedback).slice(0,3000)};return state.tasks[id];}
  function restore(saved){const state=initialState();if(saved?.version!==2)return state;for(const k of Object.keys(profile)){if(typeof saved.profile?.[k]===typeof profile[k])state.profile[k]=typeof profile[k]==="string"?saved.profile[k].slice(0,400):Math.min(40,Math.max(.5,saved.profile[k]));}if(Array.isArray(saved.values)&&saved.values.slice().sort().join()==="0,1,2")state.values=saved.values;for(const t of tasks){const v=saved.tasks?.[t.id];if(!v)continue;updateTask(state,t.id,v);if(typeof v.arrangement==="string")state.tasks[t.id].arrangement=v.arrangement.slice(0,8000);if(Number.isInteger(v.scheduledWeek)&&v.scheduledWeek>=1&&v.scheduledWeek<=16)state.tasks[t.id].scheduledWeek=v.scheduledWeek;if(Number.isInteger(v.plannedMinutes)&&v.plannedMinutes>0&&v.plannedMinutes<=240)state.tasks[t.id].plannedMinutes=v.plannedMinutes;}for(const k of ["evidence","interestFeedback","reviews","adjustments"])if(Array.isArray(saved[k]))state[k]=saved[k].filter(v=>v&&typeof v==="object").slice(-100);return state;}
  function stats(state,week=1){const rows=tasks.filter(t=>!t.buffer&&state.tasks[t.id].scheduledWeek===week);return {total:rows.length,done:rows.filter(t=>state.tasks[t.id].status==="done").length,doing:rows.filter(t=>state.tasks[t.id].status==="doing").length,pending:rows.filter(t=>state.tasks[t.id].status==="pending").length};}
  const api={profile,interest,values,experiences,categories,weeks,tasks,goal,summary,advice,consultation,initialState,restore,updateTask,stats};
  if(typeof module==="object"&&module.exports)module.exports=api;else root.CareerWorkspace=api;
})(typeof window!=="undefined"?window:globalThis);
