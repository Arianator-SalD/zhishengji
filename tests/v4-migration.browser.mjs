// Run with ego-browser against tests.browser_harness (synthetic recorder and providers).
import assert from 'node:assert/strict';

export async function verifyV4Migration(page) {
  assert.ok((await page.url()).startsWith('http://127.0.0.1:'));
  await page.reload();
  await page.waitForFunction(() => window.zhijianVoice && document.getElementById('voiceStatus').textContent.includes('DeepSeek'));
  await page.evaluate(() => {
    window.__inputFrames = 0; window.__audioEnds = 0; window.__textRequests = 0;
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (typeof data !== 'string') ++window.__inputFrames;
      else {
        const m = JSON.parse(data);
        if (m.type === 'audio.end') ++window.__audioEnds;
        if (m.type === 'input.text') ++window.__textRequests;
      }
      return original.call(this, data);
    };
    // No physical microphone or permission is used: feed a silent MediaStream.
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext(); await ctx.resume();
      const oscillator = ctx.createOscillator(), gain = ctx.createGain(), dest = ctx.createMediaStreamDestination();
      gain.gain.value = 0; oscillator.connect(gain); gain.connect(dest); oscillator.start();
      window.__syntheticMic = {ctx, oscillator};
      return dest.stream;
    };
    // Ego's AudioWorklet loading can remain pending. Test recorder lifecycle with
    // synthetic PCM frames; tests/audio-worklet.test.cjs checks the real processor.
    Worklet.prototype.addModule = async () => {};
    window.AudioWorkletNode = function(ctx) {
      const node = ctx.createGain();
      node.port = {onmessage: null};
      const timer = setInterval(() => node.port.onmessage?.({data: {buffer: new ArrayBuffer(3200), rms: 0}}), 100);
      const disconnect = node.disconnect.bind(node);
      node.disconnect = () => { clearInterval(timer); disconnect(); };
      return node;
    };
    openExpertDetail(0); callBtn.click();
  });
  await page.click('#callNext');
  await page.waitForFunction(() => window.__inputFrames >= 45);
  assert.equal(await page.evaluate(() => window.__audioEnds), 0);
  assert.match(await page.evaluate(() => document.getElementById('callNext').textContent), /说完了，发送/);
  await page.click('#callNext');
  await page.waitForFunction(() => document.getElementById('callStatus').textContent.includes('回答完成'));
  assert.deepEqual(await page.evaluate(() => ({
    ends: window.__audioEnds,
    questions: [...document.querySelectorAll('#callTranscript .call-line.user')].map(x => x.querySelector('.call-line-text').textContent),
    identity: callExpert.textContent,
    state: document.getElementById('callModal').dataset.state
  })), {ends: 1, questions: ['测试录音问题'], identity: 'Sally · AI 分身', state: 'idle'});
  await page.evaluate(() => { window.__syntheticMic.oscillator.stop(); window.__syntheticMic.ctx.close(); });
  await page.fill('#voiceTextInput', '测试文字转语音'); await page.click('#voiceTextSend');
  await page.waitForFunction(() => document.getElementById('callStatus').textContent.includes('回答完成'));
  assert.equal(await page.evaluate(() => window.__textRequests), 1);
  await page.click('#endCall');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.overlay.show').length), 0);

  // The new copy/helpful/follow-up buttons use the final streamed answer.
  await page.evaluate(() => { chatBtn.click(); window.__copiedAnswer = ''; navigator.clipboard.writeText = async text => { window.__copiedAnswer = text; }; });
  await page.click('#chatBody .ai-msg:last-child .copy-answer');
  assert.match(await page.evaluate(() => window.__copiedAnswer), /这是浏览器集成测试/);
  await page.click('#chatBody .ai-msg:last-child .helpful-answer');
  await page.click('#chatBody .ai-msg:last-child .continue-chat');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'chatInput');
  await page.evaluate(() => { closeModal('chatModal'); openExpertDetail(1); voiceMuted = true; callBtn.click(); });
  assert.match(await page.evaluate(() => callExpert.textContent), /张明轩/);
  assert.equal(await page.evaluate(() => document.querySelector('.sally-voice-compose').hidden), true);
  await page.evaluate(() => closeModal('callModal'));
  assert.equal(await page.evaluate(() => window.__textRequests), 1);

  // New record list → detail → source replay; replay never requests the backend.
  await page.evaluate(() => showPage('myConsultations'));
  assert.equal(await page.evaluate(() => document.querySelectorAll('.consult-list-row').length), 3);
  await page.click('#consultFilterBar [data-filter="chat"]');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.consult-list-row').length), 1);
  await page.click('.consult-list-row');
  await page.click('#consultOpenSourceBtn');
  assert.match(await page.evaluate(() => chatExpert.textContent), /张明轩/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#chatBody .chat-msg').length), 4);
  await page.evaluate(() => { closeModal('chatModal'); openSavedConsultation(0); });
  await page.click('#consultOpenSourceBtn');
  assert.equal(await page.evaluate(() => document.getElementById('callModal').dataset.replay), 'true');
  assert.match(await page.evaluate(() => callStatus.textContent), /咨询记录回放/);
  assert.equal(await page.evaluate(() => window.__textRequests), 1);
  await page.evaluate(() => closeModal('callModal'));

  // The newly supplied bounty form remains a local demo interaction.
  await page.evaluate(() => { showPage('community'); document.getElementById('bountyPublishBtn').click(); });
  await page.fill('#bountyTitleInput', '新版迁移的本地测试问题');
  await page.fill('#bountyDescInput', '这是浏览器自动验证使用的模拟背景，不会发送到真实社区。');
  await page.click('#confirmBountyPublish');
  assert.equal(await page.evaluate(() => document.getElementById('bountyPublishModal').classList.contains('show')), false);
  assert.ok(await page.evaluate(() => document.getElementById('community').textContent.includes('新版迁移的本地测试问题')));
  console.log('PASS: synthetic microphone / manual submit / ASR / streamed TTS, reply actions, native mock call, record filters & replays, local bounty publish');
}
