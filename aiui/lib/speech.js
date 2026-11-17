// Rokid 宿主负责采音和识别，本层只管理一次主动发起的会话。
export function createSpeechInput({ onState, onText, Recognition = globalThis.SpeechRecognition }) {
  let current = null;
  let timer = null;
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  function cancel() {
    const previous = current;
    current = null;
    clearTimer();
    try { previous?.recognition.abort(); } catch { /* 已结束的宿主会话 */ }
  }
  function fail(session, message) {
    if (current !== session) return;
    cancel();
    onState('idle', message);
  }
  function stop() {
    const session = current;
    if (!session || session.stopping) return;
    session.stopping = true;
    clearTimer();
    onState('recognizing', '正在识别…');
    timer = setTimeout(() => fail(session, '识别超时，请重试'), 5000);
    try { session.recognition.stop(); } catch { fail(session, '无法结束识别，请重试'); }
  }
  return {
    cancel,
    stop,
    start() {
      if (current) return;
      if (typeof Recognition !== 'function') {
        onState('idle', '当前设备未提供语音识别');
        return;
      }
      let recognition;
      try { recognition = new Recognition(); } catch { onState('idle', '语音识别不可用'); return; }
      const session = { recognition, text: '', stopping: false };
      current = session;
      recognition.lang = 'zh-CN';
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.onresult = (event) => {
        if (current !== session) return;
        const text = [];
        for (let index = 0; index < (event.results?.length ?? 0); index++) {
          const result = event.results[index];
          if (result.isFinal && typeof result[0]?.transcript === 'string') text.push(result[0].transcript);
        }
        session.text = text.join('').trim();
      };
      recognition.onerror = (event) => fail(session,
        ['not-allowed', 'service-not-allowed'].includes(event.error) ? '请允许麦克风权限后重试'
          : event.error === 'no-speech' ? '没有听清，请重试' : '语音识别失败，请重试');
      recognition.onnomatch = () => fail(session, '没有听清，请重试');
      recognition.onend = () => {
        if (current !== session) return;
        const text = session.text;
        cancel();
        if (text.length > 200) { onState('idle', '检索内容较长，请只说分类或文章名'); return; }
        onState('idle', text ? '' : '没有听清，请重试');
        if (text) onText(text);
      };
      onState('listening', '请说分类或文章名 · 单击结束');
      timer = setTimeout(stop, 15000);
      try { recognition.start(); } catch { fail(session, '无法启动识别，请检查麦克风权限'); }
    },
  };
}
