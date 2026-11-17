// 按用户真机反馈反转默认左右符号；修正后方向及阈值仍需实机复测。
export function createTiltFocus({ onFocus, onAvailable = () => {}, Sensor = globalThis.AbsoluteOrientationSensor,
  now = () => Date.now(), threshold = 15, neutral = 6, dwell = 180, resetDwell = 150, rightSign = -1 } = {}) {
  let current = null;
  let baseline = null;
  let candidate = '', candidateSince = 0, neutralSince = null;
  let armed = true;

  function stop() {
    const sensor = current;
    current = null;
    baseline = null;
    candidate = '';
    neutralSince = null;
    armed = true;
    try { sensor?.stop(); } catch { /* 失效的宿主会话仍保持本地关闭 */ }
  }
  function fail(sensor) {
    if (current !== sensor) return;
    stop();
    onAvailable(false);
  }
  function quaternion(value) {
    if (!value || value.length !== 4 || !Array.from(value).every(Number.isFinite)) return null;
    const length = Math.hypot(...value);
    return length > 0 ? Array.from(value, (item) => item / length) : null;
  }
  return {
    stop,
    start() {
      if (current) return;
      if (typeof Sensor !== 'function') { onAvailable(false); return; }
      let sensor;
      try { sensor = new Sensor({ frequency: 20 }); } catch { onAvailable(false); return; }
      current = sensor;
      try {
        sensor.addEventListener('error', () => fail(sensor));
        sensor.addEventListener('reading', () => {
          if (current !== sensor) return;
          const pose = quaternion(sensor.quaternion);
          if (!pose) { candidate = ''; neutralSince = null; return; }
          if (!baseline) { baseline = pose; onAvailable(true); return; }
          const [a, b, c, d] = baseline;
          const [e, f, g, h] = pose;
          // inverse(初始姿态) * 当前姿态，投影局部上方向；不使用绝对航向。
          const x = d * e - a * h - b * g + c * f;
          const y = d * f + a * g - b * h - c * e;
          const z = d * g - a * f + b * e - c * h;
          const w = d * h + a * e + b * f + c * g;
          const upX = 2 * (x * y - z * w);
          const upY = 1 - 2 * (x * x + z * z);
          const upZ = 2 * (y * z + x * w);
          if (upY < 0.5 || Math.abs(upZ) > 0.6) { candidate = ''; return; }
          const angle = Math.atan2(-upX, upY) * 180 / Math.PI * rightSign;
          const time = now();
          if (Math.abs(angle) <= neutral) {
            candidate = '';
            if (neutralSince === null) neutralSince = time;
            if (time - neutralSince >= resetDwell) armed = true;
            return;
          }
          neutralSince = null;
          if (!armed || Math.abs(angle) < threshold) { candidate = ''; return; }
          const direction = angle < 0 ? 'previous' : 'next';
          if (candidate !== direction) { candidate = direction; candidateSince = time; return; }
          if (time - candidateSince < dwell) return;
          armed = false;
          candidate = '';
          onFocus(direction);
        });
        sensor.start();
      } catch { fail(sensor); }
    },
  };
}
