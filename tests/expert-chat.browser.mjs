// Use only with tests.browser_harness on a disposable local origin.
import assert from 'node:assert/strict';

export async function verifyExpertChat(page) {
  await page.reload();
  await page.waitForFunction(() => window.zhijianChat && document.getElementById('voiceStatus').textContent.includes('可以开始咨询'));
  await page.evaluate(() => {
    window.__chatFrames = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') window.__chatFrames.push(JSON.parse(data).type);
      return send.call(this, data);
    };
  });
  const open = i => page.evaluate(i => {
    closeModal('chatModal');
    openExpertDetail(i);
    chatBtn.click();
    return {
      selected: selectedExpert, name: experts[i].name, title: chatExpert.textContent,
      greeting: chatBody.firstElementChild?.textContent,
      controlsVisible: Boolean(document.querySelector('.chat-session-bar'))
    };
  }, i);
  for (let i = 1; i < 10; i++) {
    const state = await open(i);
    assert.equal(state.selected, i);
    assert.equal(state.title, `${state.name} · AI 分身`);
    assert.ok(state.greeting.includes(state.name));
    assert.equal(state.controlsVisible, false);
    await page.fill('#chatInput', `专家 ${i} 的测试问题 <img src=x onerror=alert(1)>`);
    await page.click('#sendChat');
    await page.waitForFunction(() => chatBody.querySelectorAll('.chat-msg').length === 5 && !chatBody.querySelector('.chat-thinking-row'));
    const result = await page.evaluate(() => ({
      answer: chatBody.lastElementChild.textContent,
      hasImage: !!chatBody.querySelector('.user-msg img'), frames: window.__chatFrames
    }));
    assert.ok(result.answer.includes('我的核心判断是'));
    assert.equal(result.hasImage, false);
    assert.deepEqual(result.frames, []);
  }
  // A pending mock reply stays with its expert even if Sally is opened meanwhile.
  await open(1);
  await page.fill('#chatInput', '延迟模拟回复');
  await page.click('#sendChat');
  const sally = await open(0);
  assert.equal(sally.controlsVisible, false);
  assert.equal(await page.evaluate(() => chatBody.children.length), 0);
  await open(1);
  await page.waitForFunction(() => chatBody.querySelectorAll('.chat-msg').length === 7 && !chatBody.querySelector('.chat-thinking-row'));
  await open(0);
  assert.equal(await page.evaluate(() => chatBody.children.length), 0);

  // Sally still reaches the backend; harness providers are intentionally synthetic.
  await page.fill('#chatInput', 'Sally 后端路由测试');
  await page.click('#sendChat');
  await page.waitForFunction(() => document.getElementById('voiceStatus').textContent.includes('回答完成'));
  assert.match(await page.evaluate(() => chatBody.lastElementChild.textContent), /这是浏览器集成测试/);
  assert.ok((await page.evaluate(() => window.__chatFrames)).includes('input.text'));

  // Switching away during a backend turn must not append late Sally content to a demo.
  await page.fill('#chatInput', '切换期间的后端回复');
  await page.click('#sendChat');
  await page.waitForFunction(() => chatBody.textContent.includes('切换期间的后端回复'));
  await open(2);
  await page.fill('#chatInput', '切换后继续模拟咨询');
  await page.click('#sendChat');
  await page.waitForFunction(() => chatBody.querySelectorAll('.chat-msg').length === 7 && !chatBody.querySelector('.chat-thinking-row'));
  assert.equal(await page.evaluate(() => chatBody.textContent.includes('浏览器集成测试')), false);
  await open(0);
  assert.equal(await page.evaluate(() => chatBody.textContent.includes('切换后继续模拟咨询')), false);
  assert.equal(await page.evaluate(() => chatBody.textContent.includes('Sally 后端路由测试')), true);
  console.log('PASS: 9 expert identities, V4 topic-aware mock replies, zero mock WebSocket traffic, safe input rendering, isolated histories and delayed replies, Sally backend routing');
}
