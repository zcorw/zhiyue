import { AudioPlayer } from 'audio';
import { createRequest } from './zhisheng.js';

export function createAudioController(source, onState, onError = () => {}) {
  let player = null;
  let request = null;
  let timer = null;
  let state = 'idle';
  const loadTimeout = typeof source === 'function' ? 30000 : 8000;

  function clearLoadingTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function changeState(next) {
    state = next;
    onState(next);
  }

  function release() {
    clearLoadingTimer();
    const pending = request;
    request = null;
    pending?.cancel();
    const oldPlayer = player;
    player = null;
    if (!oldPlayer) return;

    // 先使旧回调失效，避免停止事件覆写新状态。
    try {
      oldPlayer.stop();
    } finally {
      oldPlayer.destroy();
    }
  }

  function finish(next) {
    try {
      release();
    } catch {
      // 设备可能已经释放播放器，页面仍可继续阅读。
    }
    changeState(next);
  }

  function fail(current, code = 'audio_player') {
    if (player !== current) return;
    finish('error');
    onError({ code });
  }

  function watchLoading(current) {
    clearLoadingTimer();
    timer = setTimeout(() => fail(current, 'audio_timeout'), loadTimeout);
    changeState('loading');
  }

  function play(current) {
    if (player !== current) return;
    try {
      Promise.resolve(current.play()).catch(() => fail(current));
    } catch {
      fail(current);
    }
  }

  function openPlayer(audio) {
    try {
      const current = new AudioPlayer();
      player = current;
      let firstPlay = false;
      const playOnce = () => {
        if (player !== current || firstPlay) return;
        firstPlay = true;
        play(current);
      };
      current.onCanplay(playOnce);
      current.onPlay(() => {
        if (player !== current) return;
        clearLoadingTimer();
        changeState('playing');
      });
      current.onPause(() => {
        if (player === current) changeState('paused');
      });
      current.onEnded(() => {
        if (player === current) finish('ended');
      });
      current.onError(() => fail(current));
      watchLoading(current);
      current.autoplay = false;
      if (typeof audio === 'string') {
        current.src = audio;
      } else {
        // 完整字节交给播放器，避免播放器再发起一次网络请求。
        const ready = current.setBuffer(audio, 'audio/mpeg');
        if (typeof ready?.then === 'function') {
          Promise.resolve(ready).then(playOnce, () => fail(current));
        }
      }
    } catch {
      fail(player);
    }
  }

  function start() {
    if (typeof source !== 'function') {
      openPlayer(source);
      return;
    }
    const pending = createRequest();
    request = pending;
    timer = setTimeout(() => {
      if (request !== pending) return;
      finish('error');
      onError({ code: 'audio_download_timeout' });
    }, 90000);
    changeState('loading');
    Promise.resolve().then(() => {
      if (request === pending) return source(pending.signal, () => request !== pending);
    }).then((audio) => {
      if (request !== pending) return;
      request = null;
      openPlayer(audio);
    }, (error) => {
      if (request !== pending) return;
      finish('error');
      onError(error);
    });
  }

  return {
    toggle() {
      if (state === 'loading') {
        finish('idle');
      } else if (state === 'playing') {
        const current = player;
        try {
          Promise.resolve(current.pause()).catch(() => fail(current));
        } catch {
          fail(current);
        }
      } else if (state === 'paused') {
        watchLoading(player);
        play(player);
      } else {
        start();
      }
    },
    stop() {
      finish('idle');
    },
  };
}
