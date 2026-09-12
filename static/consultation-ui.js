// Bridge the supplied V4 prototype components to Sally's existing voice transport.
(() => {
  const $ = id => document.getElementById(id);
  const body = $('chatBody');
  const bar = document.createElement('div');
  bar.className = 'chat-session-bar';
  bar.innerHTML = '<span id="voiceStatus" role="status">正在连接…</span><button id="resetSession" type="button">新会话</button>';
  body.before(bar);
  const compose = document.createElement('div');
  compose.className = 'sally-voice-compose';
  compose.innerHTML = '<input id="voiceTextInput" aria-label="语音咨询文字输入" placeholder="也可以输入问题，听语音回答"><button id="voiceTextSend" type="button">发送</button>';
  document.querySelector('.call-v12-dialogue').append(compose);
  let memoryEnabled = true;
  function memoryPanel(id) {
    const panel = document.createElement('details');
    panel.id = id;
    panel.className = 'sally-memory';
    panel.innerHTML = '<summary>已有信息 · 演示档案</summary><label><input type="checkbox" checked> 带入金融转 AI 产品同学档案</label><p class="memory-hint">正在读取档案…</p><ul></ul><small>这是预设演示资料。切换会开始新会话；本轮补充暂不保存到下次。</small>';
    panel.querySelector('input').onchange = e => window.zhijianVoice?.setDemoProfile(e.target.checked);
    return panel;
  }
  const chatMemory = memoryPanel('chatMemory');
  bar.after(chatMemory);
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
  window.zhijianUI = {
    bindAnswer,
    memory(enabled, profile) {
      memoryEnabled = enabled;
      const known = profile?.confirmed;
      for (const panel of [chatMemory]) {
        panel.querySelector('input').checked = enabled;
        panel.querySelector('summary').textContent = enabled ? '已带入演示档案 · 查看已有信息' : '空白会话 · 可带入演示档案';
        panel.querySelector('.memory-hint').textContent = !enabled ? '当前未向模型提供这份档案。' : known ? '回答会结合以下演示背景及本次对话；你可以在对话中纠正。' : '正在读取档案…';
        const list = panel.querySelector('ul');
        list.replaceChildren();
        if (enabled && known) {
          for (const text of [known.education, ...(known.experience || []), known.ai_exposure, known.goal, known.decision_stage]) {
            if (!text) continue;
            const li = document.createElement('li'); li.textContent = text; list.append(li);
          }
        }
      }
      if (selectedExpert === 0) document.querySelector('.chat-v12-actions .context-chip').textContent = enabled ? '已结合演示档案与本次对话' : '基于本次对话';
    },
    profile(i) {
      chatMemory.hidden = i !== 0;
      const expert = experts[i];
      identityCopy.textContent = expert.demoProfile ? (expert.publicFigure ? '基于公开人物资料' : '虚构角色 · 预设回复 · 产品演示') : i === 0 ? '基于本人资料与精选问答生成' : originalIdentity;
      document.querySelector('.ai-identity-line b').textContent = expert.publicFigure ? 'AI 分身' : expert.demoProfile ? '演示分身' : 'AI 分身 · 非本人实时回复';
      document.querySelector('.profile-title-row .verify').hidden = Boolean(expert.demoProfile);
      document.querySelector('.chat-v12-actions .context-chip').textContent = expert.demoProfile ? '演示会话 · 模拟回复' : i === 0 ? (memoryEnabled ? '已结合演示档案与本次对话' : '基于本次对话') : '已结合你的职业画像';
      let source = $('expertProfileSource');
      if (!source) { source = document.createElement('a'); source.id = 'expertProfileSource'; source.className = 'profile-source'; $('detailIntro2').after(source); }
      source.hidden = !expert.source;
      if (expert.source) { source.href = expert.source; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = '人物资料来源 · 百度官网'; }

      $('detailIntro2').textContent = experts[i].intro2 || originalIntro;
    },
    chatRow(text, who) {
      if (who === 'me') return appendChatUser(text);
      removeThinking();
      const row = appendChatAI(text);
      if (selectedExpert === 0) row.querySelector('.answer-context').textContent = memoryEnabled ? 'Sally · AI 分身 · 已结合演示档案与本次对话' : 'Sally · AI 分身 · 基于本人资料与本次对话生成';
      bindAnswer(row);
      return row;
    },
    bubble(container, text, who) {
      if (container === 'chatBody') {
        const row = this.chatRow(text, who);
        return row.querySelector(who === 'me' ? '.chat-bubble' : '.chat-answer-card p');
      }
      const row = addCallLine(who === 'me' ? 'user' : 'ai', who === 'me' ? '你' : 'Sally · AI 分身', text, false, 0, null, who === 'me' ? '语音 / 文字输入' : 'AI 咨询回复');
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
      if (selectedExpert !== 0) return;
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
        thinking.querySelector('.chat-thinking-bubble > span').textContent = memoryEnabled ? '正在结合你的已有经历、问题与 Sally 的资料思考' : '正在结合你的问题与 Sally 的资料思考';
      } else if (value !== 'thinking') removeThinking();
      if (value === 'idle') { partial?.remove(); partial = null; }
    },
    clear() { removeThinking(); partial?.remove(); partial = null; },
    prepareCall() {
      $('callModal').dataset.replay = 'false';
      $('callTranscript').textContent = '';
      partial = null;
      $('callRemaining').textContent = '单次录音最长 60 秒';
      this.bubble('callTranscript', memoryEnabled ? '你好，我是 Sally 的 AI 分身。已带入这位模拟同学的金融实习与 AI 产品转型档案，你可以直接聊这次最想解决的问题。点击左侧「点击说话」，说完后点「说完了，发送」。' : '你好，我是 Sally 的 AI 分身。点击左侧「点击说话」，说完后点「说完了，发送」，我会结合你的问题和 Sally 的资料回答。', 'ai');
    }
  };

  const nativeOpen = openModal, nativeClose = closeModal;
  const nativeStart = startCallDemo, nativeEnd = $('endCall').onclick, nativeMute = $('muteBtn').onclick;
  const nativeListen = $('callNext').onclick;
  function updateCallProfile() {
    const e = experts[selectedExpert];
    $('muteBtn').hidden = selectedExpert === 0;
    $('callExpertRole').textContent = e.full;
    $('callExpertTags').innerHTML = e.tags.map(t => '<span>' + escapeHTML(t) + '</span>').join('');
    compose.hidden = selectedExpert !== 0 || $('callModal').dataset.replay === 'true';
    document.querySelector('.call-permission-note').textContent = e.demoProfile ? (e.publicFigure ? '演示分身 · 未获本人授权，模拟回复不代表本人观点。' : '虚构专家 Demo · 回复为预设演示内容。') : selectedExpert === 0
      ? 'AI 分身 · 非本人实时回复 · 使用合成音色。说完后手动发送，停顿不会自动截断。'
      : '首次允许麦克风后，本次咨询将持续复用，无需重复授权。';
  }
  openModal = function(id) {
    if (id === 'chatModal') window.zhijianChat?.select(selectedExpert);
    if (id === 'callModal') updateCallProfile();
    nativeOpen(id);
    if (selectedExpert === 0) window.zhijianVoice?.open(id);
  };
  closeModal = function(id) {
    if (selectedExpert === 0) window.zhijianVoice?.close(id);
    nativeClose(id);
    if (id === 'callModal') $('callModal').dataset.replay = 'false';
  };
  startCallDemo = function() {
    $('callModal').dataset.replay = 'false';
    updateCallProfile();
    if (selectedExpert !== 0) {
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
    if (selectedExpert !== 0) return nativeListen();
    if ($('callModal').dataset.replay === 'true') { startCallDemo(); startTimer(); }
    window.zhijianVoice?.beginMic();
  };
  $('muteBtn').onclick = () => selectedExpert === 0 ? window.zhijianVoice?.suspend() : nativeMute();
  $('endCall').onclick = () => selectedExpert === 0 ? closeModal('callModal') : nativeEnd();
  document.querySelector('.mic-btn').onclick = () => { openModal('callModal'); startTimer(); startCallDemo(); };
  document.querySelector('.call-record-btn').onclick = () => { closeModal('callModal'); showPage('myConsultations'); };
  document.querySelector('.attach-round').onclick = () => toast('Demo：附件上传暂未接入，可把相关经历整理成文字提问');
  sendMessage = () => window.zhijianChat?.send();
  $('sendChat').onclick = sendMessage;
})();
