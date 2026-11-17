import wx from 'wx';

export const readingFont = '20px sans-serif';
export const readingLineHeight = 30;

function unavailable(code) {
  return Object.assign(new Error(code), { code });
}

// 与阅读页边框盒一致：左右padding各24，上下各14，页头42、页脚50、正文上下margin各15。
// 将算出的区域同时交给模板，避免把推算值冒充未读取到的Entity尺寸。
export function readTextLayout(page) {
  const viewport = globalThis.window ?? globalThis;
  let width, height, areaStyle = '', geometrySource = 'entity';
  if (Number.isFinite(viewport.innerWidth) && Number.isFinite(viewport.innerHeight)
      && viewport.innerWidth > 0 && viewport.innerHeight > 0) {
    width = viewport.innerWidth - 48;
    height = viewport.innerHeight - 150;
    areaStyle = `width: ${width}px; height: ${height}px; flex: none;`;
    geometrySource = 'viewport';
  } else {
    const area = page.querySelector?.('#reading-area');
    width = area?.clientWidth;
    height = area?.clientHeight;
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height < readingLineHeight) {
    throw unavailable('layout_area_unavailable');
  }

  // 部分宿主的内建构造器可直接使用，却不一定挂在globalThis上。
  const CanvasClass = typeof Canvas === 'function' ? Canvas : globalThis.Canvas;
  const candidates = [
    ['offscreen', () => typeof CanvasClass === 'function' ? new CanvasClass(1, 1).getContext('2d') : null],
    ['page-canvas', () => wx.createCanvasContext?.('reading-measure')],
  ];
  for (const [measurementSource, create] of candidates) {
    try {
      const context = create();
      if (typeof context?.measureText !== 'function') continue;
      context.font = readingFont;
      const sample = context.measureText('阅A').width;
      if (!Number.isFinite(sample) || sample <= 0) continue;
      return { width, height, lineHeight: readingLineHeight, areaStyle, geometrySource, measurementSource,
        measureText(text) {
          try {
            const measured = context.measureText(text).width;
            if (Number.isFinite(measured) && measured >= 0) return measured;
          } catch { /* 只暴露测量阶段，不记录正文或原始异常。 */ }
          throw unavailable('layout_measure_failed');
        } };
    } catch { /* 离屏Canvas不可用时仍尝试页面Canvas。 */ }
  }
  throw unavailable('layout_measure_unavailable');
}
