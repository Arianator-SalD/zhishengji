const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname,'../static/index.html'),'utf8');
const array = name => vm.runInNewContext('('+html.split(`const ${name}=`)[1].split('\n];')[0]+'\n])', {IMG:new Proxy({}, {get:()=>''})});
const experts = array('experts'), questions = array('questionSets');
const context = vm.createContext({experts});
vm.runInContext(html.slice(html.indexOf('function filteredExperts('),html.indexOf('function updateExpertScroll(')),context);
const filter = category => context.filteredExperts(category);

test('displaying Li first preserves original expert IDs and all original experts', () => {
  assert.deepEqual(Array.from(experts.slice(0,10),e=>e.name), ['Sally','张明轩','李若溪','王泽宇','刘欣然','周知行','许之航','沈嘉禾','唐可宁','顾言川']);
  assert.equal(filter('全部')[0].e.name,'李彦宏');
  assert.equal(filter('全部').length,experts.length);
  assert.equal(filter('全部').find(x=>x.e.name==='Sally').i,0);
});

test('the three categories partition the directory without dropping or duplicating experts', () => {
  const groups=['行业大牛','师兄师姐','职业规划师'];
  const indices=groups.flatMap(group=>Array.from(filter(group),x=>{assert.equal(x.e.group,group);return x.i}));
  assert.equal(new Set(indices).size,experts.length);
  assert.equal(indices.length,experts.length);
  for(const group of groups) assert.ok(filter(group).length>0);
  assert.equal(filter('行业大牛')[0].e.name,'李彦宏');
});

test('each added demo has its own question set and independent simulated answer', () => {
  assert.equal(questions.length,experts.length);
  vm.runInContext(html.slice(html.indexOf('function expertPerspective('),html.indexOf('function generateExpertReply(')),context);
  const begin=html.indexOf('function generateExpertReply(');
  const end=html.indexOf('\n}',begin)+2;
  vm.runInContext(html.slice(begin,end),context);
  const answers=new Set();
  for(let i=10;i<experts.length;i++) {
    assert.ok(questions[i].length>=4);
    const answer=context.generateExpertReply(questions[i][0],i,{q:'',a:''});
    assert.match(answer,/模拟回复/);
    assert.ok(answer.includes(experts[i].demoAnswer));
    answers.add(answer);
  }
  assert.equal(answers.size,experts.length-10);
  assert.match(context.generateExpertReply('你怎么看 AI？',10,{q:'',a:''}),/非本人观点/);
});
