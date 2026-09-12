// Original HTML chat fixtures. These are local demo replies, not model responses.
const demoChatConfig = {
  replyDelayMs: 650,
  greeting: name => `你好，我是${name}老师授权的 AI 分身。我已经结合你的职业画像和当前求职目标准备好了。你现在最想解决哪个问题？`,
  initialMessages: [
    {who: 'me', text: '我想从运营转产品经理，怎么补项目经历最有效？'},
    {who: 'ai', html: '<strong>先给结论：</strong>你不需要“凭空做一个产品”，更有效的是把已有运营经历重新组织成产品问题。<br/><br/>① 选一个你真实参与过的增长/用户问题；<br/>② 用“目标—用户—方案—数据验证”改写；<br/>③ 补一个能体现产品判断的独立分析项目。<br/><br/>如果你愿意，可以把简历发来，我帮你一起挑最值得产品化表达的经历。'}
  ],
  replyHTML: '<strong>我先帮你拆成三个部分：</strong><br>1. 先确认你现在的目标岗位和时间节点；<br>2. 再把经历中最能证明能力的证据挑出来；<br>3. 最后补一项可以在 7 天内完成的行动。<br><br>如果你愿意，我可以继续基于你的职业画像给出更具体的版本。'
};

(() => {
  const body = document.getElementById('chatBody');
  const input = document.getElementById('chatInput');
  const sessions = new Map();
  let activeExpert = 0;

  function bubble({who, text, html}) {
    const node = document.createElement('div');
    node.className = 'bubble ' + who;
    // Only the static fixtures above contain HTML. User input stays plain text.
    if (html !== undefined) node.innerHTML = html;
    else node.textContent = text;
    return node;
  }
  function sessionFor(i) {
    if (!sessions.has(i)) {
      sessions.set(i, {
        nodes: i === 0 ? [] : [
          bubble({who: 'ai', text: demoChatConfig.greeting(experts[i].name)}),
          ...demoChatConfig.initialMessages.map(bubble)
        ],
        draft: ''
      });
    }
    return sessions.get(i);
  }
  function select(i) {
    if (i !== activeExpert) {
      if (activeExpert === 0) window.zhijianVoice?.suspend();
      const previous = sessionFor(activeExpert);
      previous.nodes = [...body.childNodes];
      previous.draft = input.value;
      activeExpert = i;
      const next = sessionFor(i);
      body.replaceChildren(...next.nodes);
      input.value = next.draft;
    }
    document.querySelector('.chat-session-bar').style.display = i === 0 ? '' : 'none';
  }
  function append(i, node) {
    const session = sessionFor(i);
    session.nodes.push(node);
    if (i === activeExpert) {
      body.append(node);
      body.scrollTop = body.scrollHeight;
    }
  }
  window.zhijianChat = {
    select,
    send() {
      select(selectedExpert);
      if (selectedExpert === 0) return window.zhijianVoice?.send();
      const text = input.value.trim();
      if (!text) return;
      const expert = selectedExpert;
      append(expert, bubble({who: 'me', text}));
      input.value = '';
      setTimeout(() => append(expert, bubble({who: 'ai', html: demoChatConfig.replyHTML})), demoChatConfig.replyDelayMs);
    }
  };
  select(selectedExpert);
})();
