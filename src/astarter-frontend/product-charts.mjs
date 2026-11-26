// Adapted from the existing valuescan-local chart renderer; all inputs remain local fixtures.
/** Dependency-free SVG charts. Inputs are display data, never market advice. */
const PALETTE = { grid: 'var(--line)', text: 'var(--muted)', up: 'var(--signal-up,var(--ok))', down: 'var(--signal-down,var(--error))', accent: 'var(--chart-accent)' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
const fixed = value => Number(value.toFixed(2));
const dimension = (value, fallback, min) => Math.max(min, Math.min(4096, numeric(value) ?? fallback));
const paint = (value, fallback = PALETTE.accent) => /^var\(--(?:chart-(?:accent|series-[1-8])|ok|error|muted|line)\)$/.test(String(value)) ? String(value) : /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(String(value)) || /^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)$/i.test(String(value)) ? esc(value) : fallback;
const price = value => value !== 0 && Math.abs(value) < 0.000001 ? value.toExponential(3) : value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: Math.abs(value) >= 1000 ? 2 : Math.abs(value) >= 1 ? 3 : 8 });
const compact = value => Math.abs(value) >= 1e9 ? `${fixed(value / 1e9)}B` : Math.abs(value) >= 1e6 ? `${fixed(value / 1e6)}M` : Math.abs(value) >= 1e3 ? `${fixed(value / 1e3)}K` : price(value);

// Native series shadows keep axes, hit testing and the original data geometry intact.
export function chartLightStyle(color, dark = false) {
  return {shadowColor:color,shadowBlur:dark?4:1.5,shadowOffsetX:0,shadowOffsetY:0};
}

// Zero-height SVG paths disappear with object-bounding-box shadow regions.
export function preserveChartLightBounds(host) {
  for (const filter of host.querySelectorAll('filter')) {
    if (filter.querySelector('feDropShadow')) filter.setAttribute('filterUnits', 'userSpaceOnUse');
  }
}

const lightCore = Symbol('chart-light-core'), lightSource = Symbol('chart-light-source'), lightBounds = Symbol('chart-light-bounds');
const lightGeometry = ['d','transform','clip-path','stroke-dasharray','stroke-dashoffset','opacity'];

// Reuse the renderer's exact path, including its clipping and dash geometry.
// Ownership stays on the SVG nodes: replacing/disposal releases both together.
export function applyChartSeriesLight(host, colors) {
  const tones = new Set(colors.filter(color => typeof color === 'string' && color));
  const paths = [...host.querySelectorAll('svg path')];
  const sources = new Set(paths.filter(path => !path.hasAttribute('data-chart-light-core')));
  for (const core of paths.filter(path => path.hasAttribute('data-chart-light-core'))) {
    if (!sources.has(core[lightSource]) || core.parentNode !== core[lightSource]?.parentNode) core.remove();
  }
  for (const path of sources) {
    const stroke = path.getAttribute('stroke'), fill = path.getAttribute('fill');
    const shadowed = path.getAttribute('filter')?.startsWith('url(');
    const tone = shadowed ? tones.has(stroke) ? stroke : tones.has(fill) ? fill : null : null;
    const line = tone && tones.has(stroke) && (!fill || fill === 'none');
    let solid = Boolean(tone && !line);
    if (solid) {
      const d = path.getAttribute('d');
      if (path[lightBounds]?.d !== d || !path[lightBounds]?.area) {
        // A zero-size or temporarily hidden native fill receives no extra rim.
        let area = false;
        try { const box = path.getBBox();area = box.width > 0 && box.height > 0; } catch {}
        path[lightBounds] = {d, area};
      }
      solid = path[lightBounds].area;
    }
    path.classList.toggle('chart-native-line', Boolean(line));
    path.classList.toggle('chart-native-fill', solid);
    if (tone) {
      if (path.style.getPropertyValue('--native-light-tone') !== tone) path.style.setProperty('--native-light-tone', tone);
    } else path.style.removeProperty('--native-light-tone');
    if (!line || !path.getAttribute('d')) {
      path[lightCore]?.remove();delete path[lightCore];continue;
    }
    let core = path[lightCore];
    if (!core) {
      core = path.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
      core.setAttribute('data-chart-light-core', '');core.setAttribute('class', 'chart-native-core');
      core.setAttribute('fill', 'none');core.setAttribute('stroke', 'none');
      core.setAttribute('pointer-events', 'none');core.setAttribute('aria-hidden', 'true');
      path[lightCore] = core;core[lightSource] = path;
    }
    for (const name of lightGeometry) {
      const value = path.getAttribute(name);
      if (value === null) core.removeAttribute(name);
      else if (core.getAttribute(name) !== value) core.setAttribute(name, value);
    }
    if (core.style.getPropertyValue('--native-light-tone') !== tone) core.style.setProperty('--native-light-tone', tone);
    if (path.nextSibling !== core) path.parentNode.insertBefore(core, path.nextSibling);
  }
}

export function attachChartSeriesLight(series, host) {
  let chart, requestUpdate, rows=[], points=[], options, kind, spacing=1, dark=false, disposed=false;
  const dataChanged=()=>{rows=series.data();requestUpdate?.();};
  const renderer={draw(target){
    if(!points.length)return;
    target.useBitmapCoordinateSpace(({context:ctx,horizontalPixelRatio:rx,verticalPixelRatio:ry})=>{
      ctx.save();ctx.globalAlpha=dark?.28:.12;ctx.shadowBlur=(dark?4:1.5)*Math.max(rx,ry);
      ctx.lineCap='round';ctx.lineJoin='round';
      if(kind==='Line'){
        ctx.strokeStyle=ctx.shadowColor=options.color;ctx.lineWidth=(options.lineWidth||1)*rx;ctx.beginPath();
        points.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](p.x*rx,p.y*ry));ctx.stroke();
      }else for(const p of points){
        if(kind==='Histogram'&&p.zero)continue;
        ctx.fillStyle=ctx.strokeStyle=ctx.shadowColor=p.color;
        const x=p.x*rx,w=Math.max(1,spacing*.7*rx),top=Math.min(p.top,p.bottom)*ry,h=Math.max(ry,Math.abs(p.bottom-p.top)*ry);
        if(kind==='Candlestick'){
          ctx.lineWidth=rx;ctx.beginPath();ctx.moveTo(x,p.high*ry);ctx.lineTo(x,p.low*ry);ctx.stroke();
        }
        ctx.fillRect(x-w/2,top,w,h);
      }
      ctx.restore();
    });
  }};
  const coreRenderer={draw(target){
    if(!points.length||kind==='Candlestick')return;
    target.useBitmapCoordinateSpace(({context:ctx,horizontalPixelRatio:rx,verticalPixelRatio:ry})=>{
      ctx.save();ctx.strokeStyle='#fff';ctx.globalAlpha=dark?.5:.26;ctx.shadowBlur=0;ctx.shadowColor='transparent';ctx.lineCap='round';ctx.lineJoin='round';
      if(kind==='Line'){
        ctx.lineWidth=.6*rx;ctx.beginPath();points.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](p.x*rx,p.y*ry));ctx.stroke();
      }else{
        ctx.lineWidth=.6*ry;
        for(const p of points){
          if(p.zero)continue;
          const half=Math.max(0,Math.min(spacing*.24,(spacing-1)/2))*rx;if(!half)continue;
          ctx.strokeStyle=p.color;
          ctx.beginPath();ctx.moveTo(p.x*rx-half,p.top*ry);ctx.lineTo(p.x*rx+half,p.top*ry);ctx.stroke();
        }
      }
      ctx.restore();
    });
  }};
  const views=[{zOrder:()=> 'bottom',renderer:()=>renderer},{zOrder:()=> 'top',renderer:()=>coreRenderer}];
  const primitive={
    attached(api){chart=api.chart;requestUpdate=api.requestUpdate;series.subscribeDataChanged(dataChanged);dataChanged();},
    detached(){series.unsubscribeDataChanged(dataChanged);rows=[];points=[];chart=null;requestUpdate=null;},
    paneViews:()=>views,
    updateAllViews(){
      points=[];if(!chart)return;options=series.options();if(!options.visible)return;
      kind=series.seriesType();const scale=chart.timeScale(),width=scale.width();spacing=scale.options().barSpacing;
      dark=host.ownerDocument.documentElement.dataset.theme==='dark';
      for(const row of rows){
        const x=scale.timeToCoordinate(row.time);if(!Number.isFinite(x)||x< -spacing||x>width+spacing)continue;
        if(kind==='Line'){
          if(!Number.isFinite(row.value))continue;
          const y=series.priceToCoordinate(row.value);if(Number.isFinite(y))points.push({x,y});
        }else if(kind==='Candlestick'){
          if(![row.open,row.close,row.high,row.low].every(Number.isFinite))continue;
          const top=series.priceToCoordinate(row.open),bottom=series.priceToCoordinate(row.close),high=series.priceToCoordinate(row.high),low=series.priceToCoordinate(row.low);
          if([top,bottom,high,low].every(Number.isFinite))points.push({x,top,bottom,high,low,color:row.color||(row.close>=row.open?options.upColor:options.downColor)});
        }else if(kind==='Histogram'){
          if(!Number.isFinite(row.value))continue;
          const top=series.priceToCoordinate(row.value),bottom=series.priceToCoordinate(options.base??0);
          if([top,bottom].every(Number.isFinite))points.push({x,top,bottom,zero:row.value===(options.base??0),color:row.color||options.color});
        }
      }
    },
  };
  series.attachPrimitive(primitive);
  return ()=>{if(!disposed){disposed=true;series.detachPrimitive(primitive);}};
}

function svg(width, height, title, contents, kind) {
  return `<svg xmlns="http://www.w3.org/2000/svg" class="chart chart-${kind}" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible;font-family:var(--sans,ui-sans-serif),system-ui,sans-serif"><title>${esc(title)}</title>${contents}</svg>`;
}

function empty(width, height, title, kind) {
  return svg(width, height, `${title}：暂无数据`, `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="middle" fill="${PALETTE.text}" font-size="12">暂无数据</text>`, kind);
}

function domain(values, padding = 0.08) {
  let min = Infinity, max = -Infinity;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  const space = (max - min || Math.abs(max) * 0.02 || 1) * padding;
  return [min - space, max + space];
}

function timestamp(value) {
  const number = numeric(value);
  const date = number !== null ? new Date(Math.abs(number) < 1e11 ? number * 1000 : number) : new Date(value);
  return value == null || !Number.isFinite(date.getTime()) ? null : date;
}

function timeLabel(value, full = false) {
  const date = timestamp(value);
  if (!date) return value == null ? '时间未知' : String(value);
  const iso = date.toISOString();
  return full ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

function path(points) {
  return points.map(([x, y], index) => `${index ? 'L' : 'M'}${fixed(x)},${fixed(y)}`).join(' ');
}

// Coordinates are shared by the SVG stroke and point inspectors.
export function sparklinePoints(data, width, height) {
  const pad = 3;
  const [min, max] = domain(data, 0.12);
  return data.map((value, index) => [
    data.length === 1 ? width / 2 : pad + index / (data.length - 1) * (width - pad * 2),
    height - pad - (value - min) / (max - min) * (height - pad * 2)
  ]);
}

/** Numeric values; invalid entries are ignored. */
export function sparkline(values, { width = 240, height = 60, color, fill = true } = {}) {
  width = dimension(width, 240, 40); height = dimension(height, 60, 20);
  const data = Array.isArray(values) ? values.map(numeric).filter(value => value !== null) : [];
  if (!data.length) return empty(width, height, '价格走势', 'sparkline');
  const stroke = paint(color, PALETTE.accent), pad = 3;
  const points = sparklinePoints(data, width, height);
  const line = path(points), first = points[0], last = points.at(-1);
  const area = fill && data.length > 1 ? `<path d="${line} L${fixed(last[0])},${height - pad} L${fixed(first[0])},${height - pad} Z" fill="${stroke}" fill-opacity="0.09"/>` : '';
  return svg(width, height, `价格走势，${data.length}个数据点，起点${price(data[0])}，终点${price(data.at(-1))}`, `${area}<path class="chart-light-envelope" d="${line}" fill="none" stroke="${stroke}"/><path class="chart-light-line" d="${line}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path class="chart-light-core" d="${line}" fill="none"/><circle class="chart-light-point" cx="${fixed(last[0])}" cy="${fixed(last[1])}" r="2.2" fill="${stroke}" style="--point-light:${stroke}"/>`, 'sparkline');
}

/** OHLCV bars, preserved in input order; time accepts Unix seconds/ms or ISO. */
export function candlestickChart(bars, { width = 900, height = 320, levels = [], period = '1h' } = {}) {
  width = dimension(width, 900, 240); height = dimension(height, 320, 220);
  const data = (Array.isArray(bars) ? bars : []).map(bar => {
    if (!bar || typeof bar !== 'object') return null;
    const open = numeric(bar.open), high = numeric(bar.high), low = numeric(bar.low), close = numeric(bar.close);
    if ([open, high, low, close].includes(null) || high < Math.max(open, close) || low > Math.min(open, close) || low > high) return null;
    return { time: bar.time, open, high, low, close, volume: Math.max(0, numeric(bar.volume) ?? 0) };
  }).filter(Boolean);
  const title = `${period} K线与成交量`;
  if (!data.length) return empty(width, height, title, 'candlestick');
  const safeLevels = (Array.isArray(levels) ? levels : []).filter(level => level && numeric(level.price) !== null).map(level => ({ price: Number(level.price), label: String(level.label ?? '参考位'), color: paint(level.color) }));
  const margin = { left: 12, right: 86, top: width < 600 ? 48 : 36, bottom: 27 };
  const axisFont = 12;
  const plotWidth = width - margin.left - margin.right;
  const volumeHeight = Math.max(30, height * 0.16);
  const priceBottom = height - margin.bottom - volumeHeight - 18;
  const priceHeight = priceBottom - margin.top;
  const volumeTop = priceBottom + 14, volumeBottom = height - margin.bottom;
  const [min, max] = domain(data.flatMap(bar => [bar.low, bar.high]), 0.08);
  const y = value => margin.top + (max - value) / (max - min) * priceHeight;
  const step = plotWidth / data.length, bodyWidth = Math.max(0.4, Math.min(12, step * 0.62));
  const x = index => margin.left + step * (index + 0.5);
  const volumeMax = Math.max(1, ...data.map(bar => bar.volume));
  let contents = '';
  for (let index = 0; index <= 4; index++) {
    const yy = margin.top + index / 4 * priceHeight, value = max - index / 4 * (max - min);
    contents += `<line x1="${margin.left}" y1="${fixed(yy)}" x2="${width - margin.right}" y2="${fixed(yy)}" stroke="${PALETTE.grid}" stroke-opacity="0.65" stroke-dasharray="3 4"/><text x="${width - margin.right + 9}" y="${fixed(yy + 4)}" fill="${PALETTE.text}" font-size="${axisFont}">${esc(price(value))}</text>`;
  }
  const ticks = Math.min(5, Math.max(2, Math.floor(plotWidth / 135)));
  const tickIndices = [...new Set(Array.from({ length: ticks }, (_, i) => Math.round(i * (data.length - 1) / (ticks - 1))))];
  for (const index of tickIndices) {
    const xx = x(index), anchor = index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle';
    contents += `<line x1="${fixed(xx)}" y1="${margin.top}" x2="${fixed(xx)}" y2="${volumeBottom}" stroke="${PALETTE.grid}" stroke-opacity="0.45"/><text x="${fixed(xx)}" y="${height - 7}" fill="${PALETTE.text}" font-size="${axisFont}" text-anchor="${anchor}">${esc(timeLabel(data[index].time))}</text>`;
  }
  for (const [index, bar] of data.entries()) {
    const xx = x(index), tone = bar.close >= bar.open ? PALETTE.up : PALETTE.down;
    const top = Math.min(y(bar.open), y(bar.close)), bodyHeight = Math.max(1, Math.abs(y(bar.open) - y(bar.close)));
    const volumePixels = bar.volume / volumeMax * volumeHeight;
    const description = `${timeLabel(bar.time, true)} · 开 ${price(bar.open)} · 高 ${price(bar.high)} · 低 ${price(bar.low)} · 收 ${price(bar.close)} · 量 ${price(bar.volume)}`;
    contents += `<g class="chart-candle ${bar.close>=bar.open?'chart-positive':'chart-negative'}" data-bucket="${esc(bar.time ?? index)}" data-index="${index}" data-close="${bar.close}"><title>${esc(description)}</title><line x1="${fixed(xx)}" y1="${fixed(y(bar.high))}" x2="${fixed(xx)}" y2="${fixed(y(bar.low))}" stroke="${tone}" stroke-width="1"/><rect x="${fixed(xx - bodyWidth / 2)}" y="${fixed(top)}" width="${fixed(bodyWidth)}" height="${fixed(bodyHeight)}" rx="0.5" fill="${tone}"/><rect x="${fixed(xx - bodyWidth / 2)}" y="${fixed(volumeBottom - volumePixels)}" width="${fixed(bodyWidth)}" height="${fixed(volumePixels)}" fill="${tone}" fill-opacity="0.32"/></g>`;
  }
  for (const level of safeLevels) {
    if (level.price < min || level.price > max) continue;
    const yy = y(level.price), text = `${level.label} ${price(level.price)}`;
    contents += `<g class="chart-price-level"><title>${esc(text)}</title><line x1="${margin.left}" y1="${fixed(yy)}" x2="${width - margin.right}" y2="${fixed(yy)}" stroke="${level.color}" stroke-opacity="0.75" stroke-dasharray="5 5"/><text x="${margin.left + 4}" y="${fixed(yy - 5)}" fill="${level.color}" font-size="${axisFont}" stroke="var(--surface)" stroke-width="3" paint-order="stroke">${esc(text)}</text></g>`;
  }
  const last = data.at(-1), lastY = y(last.close), lastTone = last.close >= last.open ? PALETTE.up : PALETTE.down;
  contents += `<line x1="${margin.left}" y1="${fixed(lastY)}" x2="${width - margin.right}" y2="${fixed(lastY)}" stroke="${lastTone}" stroke-opacity="0.55" stroke-dasharray="2 4"/><rect x="${width - margin.right + 3}" y="${fixed(lastY - 10)}" width="${margin.right - 6}" height="20" rx="3" fill="${lastTone}"/><text x="${width - margin.right / 2}" y="${fixed(lastY + 4)}" text-anchor="middle" fill="var(--chart-price-ink,#fff)" font-size="${axisFont}" font-weight="600">${esc(price(last.close))}</text>`;
  const ohlcX = width < 600 ? margin.left : margin.left + 90, ohlcY = width < 600 ? 32 : 16;
  contents += `<text x="${margin.left}" y="16" fill="${PALETTE.text}" font-size="${axisFont}">${esc(period)} · UTC</text><text x="${margin.left + 2}" y="${fixed(volumeTop + 9)}" fill="${PALETTE.text}" font-size="9">VOL ${esc(compact(last.volume))}</text>`;
  return svg(width, height, `${title}，${data.length}根，最新收盘${price(last.close)}，坐标时间UTC`, contents, 'candlestick');
}

