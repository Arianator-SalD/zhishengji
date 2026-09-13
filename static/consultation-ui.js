// Bridge the prototype components to the selected expert's live voice transport.
(() => {
  const $ = id => document.getElementById(id);
  const feedback = document.createElement('p');
  feedback.id = 'voiceStatus';
  feedback.className = 'chat-input-feedback';
  feedback.setAttribute('role', 'status');
  feedback.hidden = true;
  document.querySelector('.chat-v12-compose').before(feedback);
  const compose = document.createElement('div');
  compose.className = 'sally-voice-compose';
  compose.innerHTML = '<input id="voiceTextInput" aria-label="语音咨询文字输入" placeholder="也可以输入问题，听语音回答"><button id="voiceTextSend" type="button">发送</button>';
  document.querySelector('.call-v12-dialogue').append(compose);
  let memoryEnabled = true, memoryExpert = null;
  const isLive = () => Boolean(experts[selectedExpert]?.voiceId);
  let thinking, partial;
  const originalIntro = $('detailIntro2').textContent;
  const identityCopy = document.querySelector('.ai-identity-line > span:last-child');
  const originalIdentity = identityCopy.textContent;

  function bindAnswer(row) {
    const answer = row.querySelector('.chat-answer-card');
    if (!answer) return;
    const copy = answer.querySelector('.copy-answer');
    if (copy) copy.onclick = async () => {
      const text = [...answer.querySelectorAll('p,li')].map(node => node.textContent).join('\n');
      try { await navigator.clipboard.writeText(text); toast('回答已复制'); }
      catch { toast('复制未成功，可以选中文字手动复制'); }
    };
    const helpful = answer.querySelector('.helpful-answer') || answer.querySelector('button');
    if (helpful) helpful.onclick = () => { helpful.textContent = '已标记有帮助'; helpful.style.color = '#5967df'; };
    const follow = answer.querySelector('.continue-chat');
    if (follow) follow.onclick = () => { $('chatInput').focus(); $('chatInput').placeholder = '继续追问刚才的建议...'; };
  }
  function removeThinking() { thinking?.remove(); thinking = null; }
  function callIntroduction() {
    const expert = experts[selectedExpert];
    return '你好，我是' + expert.name + '的 AI 分身。' + (expert.publicFigure ? '我会结合公开资料和你的问题回答。' : '')
      + '你这次最想聊什么？'
      + '点击左侧「点击说话」，说完后点「说完了，发送」。';
  }
  window.zhijianUI = {
    bindAnswer,
    memory(enabled, profile, expertId) {
      memoryExpert = expertId;
      memoryEnabled = enabled;
      if (isLive()) document.querySelector('.chat-v12-actions .context-chip').textContent = enabled ? '已结合演示档案与本次对话' : '基于本次对话';
    },
    profile(i) {
      feedback.hidden = true;
      const expert = experts[i];
      $('chatExpertSubtitle').textContent = expert.publicFigure ? 'AI 分身 · 基于公开资料与本次对话' : expert.voiceId ? 'AI 分身 · 基于本人资料与精选问答' : expert.demoProfile ? '演示分身 · 虚构角色与预设回复' : 'AI 分身 · 基于专家经验与真实案例';
      identityCopy.textContent = expert.publicFigure ? '基于公开人物资料' : expert.demoProfile ? '虚构角色 · 预设回复 · 产品演示' : expert.voiceId ? '基于本人资料与精选问答生成' : originalIdentity;
      document.querySelector('.ai-identity-line b').textContent = expert.publicFigure ? 'AI 分身' : expert.demoProfile ? '演示分身' : 'AI 分身 · 非本人实时回复';
      document.querySelector('.profile-title-row .verify').hidden = Boolean(expert.demoProfile || expert.publicFigure);
      document.querySelector('.chat-v12-actions .context-chip').textContent = expert.demoProfile ? '演示会话 · 模拟回复' : expert.voiceId ? (memoryEnabled && memoryExpert === expert.voiceId ? '已结合演示档案与本次对话' : '基于本次对话') : '已结合你的职业画像';
      $('detailIntro2').textContent = experts[i].intro2 || originalIntro;
    },
    chatRow(text, who) {
      if (who === 'me') return appendChatUser(text);
      removeThinking();
      const row = appendChatAI(text);
      if (isLive()) row.querySelector('.answer-context').textContent = experts[selectedExpert].name + ' · AI 分身 · ' + (memoryEnabled ? '已结合演示档案与本次对话' : experts[selectedExpert].publicFigure ? '基于公开资料与本次对话生成' : '基于本人资料与本次对话生成');
      bindAnswer(row);
      return row;
    },
    bubble(container, text, who) {
      if (container === 'chatBody') {
        const row = this.chatRow(text, who);
        return row.querySelector(who === 'me' ? '.chat-bubble' : '.chat-answer-card p');
      }
      const row = addCallLine(who === 'me' ? 'user' : 'ai', who === 'me' ? '你' : experts[selectedExpert].name + ' · AI 分身', text, false, 0, null, who === 'me' ? '语音 / 文字输入' : 'AI 咨询回复');
      return row.querySelector('.call-line-text');
    },
    partial(text) {
      if (!partial) partial = addCallLine('user', '你', '', false, 0, null, '实时转写');
      partial.querySelector('.call-line-text').textContent = text;
      $('callTranscript').scrollTop = $('callTranscript').scrollHeight;
    },
    finishTranscript(text) {
      if (partial) {
        if (text) partial.querySelector('.call-line-text').textContent = text;
        else partial.remove();
        partial = null;
      } else if (text) this.bubble('callTranscript', text, 'me');
    },
    state(value, {recording, busy, hasAudio, mode}) {
      if (!isLive()) return;
      const label = recording ? '说完了，发送' : busy || hasAudio ? '打断并说话' : '点击说话';
      $('callNext').innerHTML = callControlIcon(recording ? 'send' : 'mic', true) + '<small>' + label + '</small>';
      $('callNext').setAttribute('aria-label', label);
      $('callNext').className = 'voice-main-btn ' + (recording ? 'listening' : value === 'speaking' ? 'speaking' : 'listen');
      $('muteBtn').hidden = true;
      $('callThinking').classList.toggle('show', value === 'thinking');
      $('callWave').classList.toggle('listening', recording);
      $('callWave').classList.toggle('speaking', value === 'speaking');
      if (value === 'thinking' && mode === 'text' && !thinking) {
        thinking = appendChatThinking();
        thinking.querySelector('.chat-thinking-bubble > span').textContent = '正在结合你的' + (memoryEnabled ? '已有经历、' : '') + '问题与' + experts[selectedExpert].name + '的资料思考';
      } else if (value !== 'thinking') removeThinking();
      if (value === 'idle') { partial?.remove(); partial = null; }
    },
    clear() { removeThinking(); partial?.remove(); partial = null;  },
    prepareCall() {
      $('callModal').dataset.replay = 'false';
      $('callTranscript').textContent = '';
      partial = null;
      $('callRemaining').textContent = '单次录音最长 60 秒';
      this.bubble('callTranscript', callIntroduction(), 'ai');
    }
  };

  const nativeOpen = openModal, nativeClose = closeModal;
  const nativeStart = startCallDemo, nativeEnd = $('endCall').onclick, nativeMute = $('muteBtn').onclick;
  const nativeListen = $('callNext').onclick;
  function updateCallProfile() {
    const e = experts[selectedExpert];
    $('muteBtn').hidden = isLive();
    $('callExpertRole').textContent = e.full;
    $('callExpertTags').innerHTML = e.tags.map(t => '<span>' + escapeHTML(t) + '</span>').join('');
    compose.hidden = !isLive() || $('callModal').dataset.replay === 'true';
    document.querySelector('.call-permission-note').textContent = e.demoProfile ? (e.publicFigure ? '演示分身 · 未获本人授权，模拟回复不代表本人观点。' : '虚构专家 Demo · 回复为预设演示内容。') : e.voiceId
      ? (e.publicFigure ? 'AI 分身 · 基于公开资料 · 非本人实时回复 · 使用合成音色。说完后手动发送。' : 'AI 分身 · 非本人实时回复 · 使用合成音色。说完后手动发送，停顿不会自动截断。')
      : '首次允许麦克风后，本次咨询将持续复用，无需重复授权。';
  }
  openModal = function(id) {
    if (id === 'chatModal' || id === 'callModal') window.zhijianChat?.select(selectedExpert);
    if (id === 'callModal') updateCallProfile();
    nativeOpen(id);
    if (isLive()) window.zhijianVoice?.open(id);
  };
  closeModal = function(id) {
    if (isLive()) window.zhijianVoice?.close(id);
    nativeClose(id);
    if (id === 'callModal') $('callModal').dataset.replay = 'false';
  };
  startCallDemo = function() {
    window.zhijianChat?.select(selectedExpert);
    $('callModal').dataset.replay = 'false';
    updateCallProfile();
    if (!isLive()) {
      $('muteBtn').disabled = false;
      $('muteBtn').innerHTML = callControlIcon(voiceMuted ? 'muted' : 'volume') + '<small>' + (voiceMuted ? '取消静音' : '静音') + '</small>';
      $('muteBtn').setAttribute('aria-pressed', String(voiceMuted));
      $('muteBtn').title = voiceMuted ? '取消静音' : '静音';
      return nativeStart();
    }
    stopCallDemo();
    window.zhijianUI.prepareCall();
    window.zhijianVoice?.startCall();
  };
  // Dispatch existing controls to the appropriate provider without changing expert identity.
  $('callNext').onclick = () => {
    if (!isLive()) return nativeListen();
    if ($('callModal').dataset.replay === 'true') { startCallDemo(); startTimer(); }
    window.zhijianVoice?.beginMic();
  };
  $('muteBtn').onclick = () => isLive() ? window.zhijianVoice?.suspend() : nativeMute();
  $('endCall').onclick = () => isLive() ? closeModal('callModal') : nativeEnd();
  document.querySelector('.call-record-btn').onclick = () => { closeModal('callModal'); showPage('myConsultations'); };
  document.querySelector('.attach-round').onclick = () => toast('Demo：附件上传暂未接入，可把相关经历整理成文字提问');
  sendMessage = () => window.zhijianChat?.send();
  $('sendChat').onclick = sendMessage;
})();
