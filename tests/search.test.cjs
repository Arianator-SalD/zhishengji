const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {find} = require('../static/search.js');
const html = fs.readFileSync(path.join(__dirname,'../static/index.html'),'utf8');
const array = name => vm.runInNewContext('('+html.split(`const ${name}=`)[1].split('\n];')[0]+'\n])', {
  IMG:new Proxy({}, {get:()=>''})
});
const experts = array('experts'), questions = array('questionSets');
questions[0] = JSON.parse(fs.readFileSync(path.join(__dirname,'../content/qa.json'),'utf8')).map(q=>q.question);

test('expert names rank correctly regardless of letter case, including experts outside the default five', () => {
  for (const [query,index] of [[' SALLY ',0],['张明轩',1],['周知行',5]]) {
    const first = find(query,experts,questions)[0];
    assert.equal(first.kind,'expert'); assert.equal(first.expertIndex,index);
  }
});
test('job topics and natural questions find relevant existing content', () => {
  assert.ok(find('数据分析',experts,questions).some(r=>r.kind==='expert' && r.expertIndex===5));
  assert.ok(find('金融转行想做人工智能产品',experts,questions).some(r=>r.kind==='expert' && r.expertIndex===0));
  const question = questions[0][1];
  assert.ok(find(question,experts,questions).some(r=>r.kind==='question' && r.expertIndex===0 && r.question===question));
});
test('empty input offers bounded suggestions and unmatched text has no invented results', () => {
  assert.ok(find('',experts,questions).length<=8);
  assert.equal(find('不存在的zzzzzz专家',experts,questions).length,0);
  assert.equal(find('<script>alert(123456789)</script>',experts,questions).length,0);
});
