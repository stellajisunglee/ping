// Home's progress card under My Stack: the minutes of Japanese the learner has spoken on calls, adding up call
// by call, as a small area chart that only ever grows. Once enough calls have been graded, it also says what
// level their speaking sounds like. Plain SVG, no libraries.

import { $, el, state } from './lib.js';

const WIDTH = 320;
const HEIGHT = 120;
const PAD = { top: 12, right: 12, bottom: 22, left: 8 };
const SVG_NS = 'http://www.w3.org/2000/svg';

const svgEl = (tag, attributes = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
};

const dateText = (at) => new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
export const minutesText = (minutes) => (minutes < 10 ? minutes.toFixed(1) : String(Math.round(minutes)));

// Where each point goes. One point sits at the right edge; the y axis starts at 0 and leaves headroom.
export function layout(points, { width = WIDTH, height = HEIGHT } = {}) {
  const first = points[0].at;
  const last = points.at(-1).at;
  const top = Math.max(1, points.at(-1).minutes) * 1.15;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const x = (at) => (last === first ? PAD.left + plotWidth : PAD.left + ((at - first) / (last - first)) * plotWidth);
  const y = (minutes) => PAD.top + plotHeight - (minutes / top) * plotHeight;
  return { x, y, baseline: PAD.top + plotHeight, points: points.map((point) => ({ ...point, cx: x(point.at), cy: y(point.minutes) })) };
}

function drawChart(points) {
  const { baseline, points: placed } = layout(points);
  const chart = svgEl('svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, class: 'progress-svg', role: 'img', tabindex: '0' });
  chart.setAttribute('aria-label', `Minutes of Japanese spoken, adding up from ${minutesText(placed[0].minutes)} on ${dateText(placed[0].at)} to ${minutesText(placed.at(-1).minutes)} on ${dateText(placed.at(-1).at)}. Use the arrow keys to read each call.`);
  // Steps, since the total only changes when a call ends.
  const start = placed[0];
  const end = placed.at(-1);
  const steps = placed.slice(1).map((point) => `H${point.cx}V${point.cy}`).join('');
  chart.append(
    svgEl('line', { x1: PAD.left, x2: WIDTH - PAD.right, y1: baseline, y2: baseline, class: 'progress-baseline' }),
    svgEl('path', { d: `M${start.cx},${baseline}V${start.cy}${steps}V${baseline}Z`, class: 'progress-area' }),
    svgEl('path', { d: `M${start.cx},${start.cy}${steps}`, class: 'progress-line' }),
    svgEl('circle', { cx: end.cx, cy: end.cy, r: 4, class: 'progress-end' }),
  );
  const firstLabel = svgEl('text', { x: PAD.left, y: HEIGHT - 6, class: 'progress-axis' });
  firstLabel.textContent = dateText(start.at);
  const lastLabel = svgEl('text', { x: WIDTH - PAD.right, y: HEIGHT - 6, class: 'progress-axis', 'text-anchor': 'end' });
  lastLabel.textContent = placed.length > 1 ? dateText(end.at) : '';
  chart.append(firstLabel, lastLabel);

  // The crosshair: a hairline and a dot that snap to the nearest call, with its total read out.
  const hair = svgEl('line', { y1: PAD.top, y2: baseline, class: 'progress-hair', visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4, class: 'progress-end', visibility: 'hidden' });
  chart.append(hair, dot);
  return { chart, placed, hair, dot };
}

function attachReadout(holder, { chart, placed, hair, dot }) {
  const readout = el('p', { className: 'progress-readout', ariaLive: 'polite' });
  let index = placed.length - 1;
  const showPoint = (next) => {
    index = Math.max(0, Math.min(placed.length - 1, next));
    const point = placed[index];
    for (const node of [hair, dot]) node.setAttribute('visibility', 'visible');
    hair.setAttribute('x1', point.cx);
    hair.setAttribute('x2', point.cx);
    dot.setAttribute('cx', point.cx);
    dot.setAttribute('cy', point.cy);
    readout.textContent = `${dateText(point.at)}: ${minutesText(point.minutes)} min in all`;
  };
  const hide = () => {
    for (const node of [hair, dot]) node.setAttribute('visibility', 'hidden');
    readout.textContent = '';
  };
  const nearest = (event) => {
    const box = chart.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * WIDTH;
    let best = 0;
    placed.forEach((point, at) => {
      if (Math.abs(point.cx - x) < Math.abs(placed[best].cx - x)) best = at;
    });
    showPoint(best);
  };
  chart.addEventListener('pointermove', nearest);
  chart.addEventListener('pointerdown', nearest);
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('blur', hide);
  chart.addEventListener('focus', () => showPoint(index));
  chart.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') showPoint(index - 1);
    else if (event.key === 'ArrowRight') showPoint(index + 1);
    else return;
    event.preventDefault();
  });
  holder.append(readout);
}

function renderLevel(progress) {
  const line = $('progress-level');
  if (progress.speakingLevel) {
    line.replaceChildren(el('strong', { textContent: `Your speaking sounds about ${progress.speakingLevel}` }), el('span', { className: 'muted', textContent: ' · from your last 5 recorded calls' }));
    line.hidden = false;
  } else if (state.me.recording?.on && progress.gradedCalls > 0) {
    line.replaceChildren(el('span', { className: 'muted', textContent: `After ${progress.callsUntilLevel} more call${progress.callsUntilLevel === 1 ? '' : 's'}, Ping will estimate your speaking level.` }));
    line.hidden = false;
  } else {
    line.hidden = true;
  }
}

// The "Japanese vs English" view: for each of the latest calls, a bar split into the share of the learner's turns in
// Japanese (bottom) and mostly in English (top), with a 2px gap between them. Tap or move along it to read a call.
function drawRatioChart(calls) {
  const chart = svgEl('svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, class: 'progress-svg', role: 'img', tabindex: '0' });
  const latest = calls.at(-1);
  chart.setAttribute('aria-label', `Share of your turns in Japanese on your last ${calls.length} call${calls.length === 1 ? '' : 's'}, most recently ${latest.japanesePercent}%. Use the arrow keys to read each call.`);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const baseline = PAD.top + plotHeight;
  const slot = plotWidth / Math.max(calls.length, 8); // a few calls stay narrow instead of filling the width
  const barWidth = Math.max(4, Math.min(22, slot - 4));
  const GAP = 2;
  const bars = calls.map((call, index) => {
    const x = PAD.left + index * slot + (slot - barWidth) / 2;
    const japanese = (call.japanesePercent / 100) * plotHeight;
    const english = plotHeight - japanese;
    const group = svgEl('g', { class: 'ratio-bar' });
    if (english > GAP) group.append(svgEl('rect', { x, y: PAD.top, width: barWidth, height: english - GAP, rx: 2, class: 'ratio-english' }));
    if (japanese > 0) group.append(svgEl('rect', { x, y: baseline - japanese, width: barWidth, height: japanese, rx: 2, class: 'ratio-japanese' }));
    group.append(svgEl('rect', { x: PAD.left + index * slot, y: PAD.top, width: slot, height: plotHeight, class: 'ratio-hit' }));
    chart.append(group);
    return { ...call, group, cx: x + barWidth / 2 };
  });
  chart.prepend(svgEl('line', { x1: PAD.left, x2: WIDTH - PAD.right, y1: baseline, y2: baseline, class: 'progress-baseline' }));
  const first = svgEl('text', { x: PAD.left, y: HEIGHT - 6, class: 'progress-axis' });
  first.textContent = dateText(calls[0].at);
  const last = svgEl('text', { x: bars.at(-1).cx, y: HEIGHT - 6, class: 'progress-axis', 'text-anchor': calls.length > 1 ? 'middle' : 'start' });
  last.textContent = calls.length > 1 ? dateText(latest.at) : '';
  chart.append(first, last);
  return { chart, bars };
}

function attachRatioReadout(holder, { chart, bars }) {
  const readout = el('p', { className: 'progress-readout', ariaLive: 'polite' });
  let index = bars.length - 1;
  const showBar = (next) => {
    index = Math.max(0, Math.min(bars.length - 1, next));
    bars.forEach((bar, at) => bar.group.classList.toggle('active', at === index));
    const bar = bars[index];
    readout.textContent = `${dateText(bar.at)}: ${bar.japanesePercent}% Japanese, ${100 - bar.japanesePercent}% English`;
  };
  const hide = () => {
    bars.forEach((bar) => bar.group.classList.remove('active'));
    readout.textContent = '';
  };
  const nearest = (event) => {
    const box = chart.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * WIDTH;
    let best = 0;
    bars.forEach((bar, at) => {
      if (Math.abs(bar.cx - x) < Math.abs(bars[best].cx - x)) best = at;
    });
    showBar(best);
  };
  chart.addEventListener('pointermove', nearest);
  chart.addEventListener('pointerdown', nearest);
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('blur', hide);
  chart.addEventListener('focus', () => showBar(index));
  chart.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') showBar(index - 1);
    else if (event.key === 'ArrowRight') showBar(index + 1);
    else return;
    event.preventDefault();
  });
  holder.append(readout);
}

// Which view the card shows, kept per phone.
const VIEW_KEY = 'ping-progress-view';
function currentView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'ratio' ? 'ratio' : 'minutes';
  } catch {
    return 'minutes';
  }
}

function chooseView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {}
  renderProgress();
}

export function renderProgress() {
  const progress = state.me.progress ?? { points: [], calls: [], totalMinutes: 0, speakingLevel: null, gradedCalls: 0, callsUntilLevel: 5 };
  const view = currentView();
  for (const button of document.querySelectorAll('.progress-view')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  const holder = $('progress-chart');
  $('progress-legend').hidden = view !== 'ratio' || !progress.calls?.length;
  if (view === 'ratio') {
    const calls = progress.calls ?? [];
    const recent = calls.slice(-5);
    $('progress-title').textContent = 'Japanese vs English';
    $('progress-total').textContent = recent.length ? `${Math.round(recent.reduce((sum, call) => sum + call.japanesePercent, 0) / recent.length)}%` : '–';
    $('progress-unit').textContent = recent.length ? `in Japanese, last ${recent.length} call${recent.length === 1 ? '' : 's'}` : '';
    if (!calls.length) holder.replaceChildren(el('p', { className: 'muted', textContent: 'After your first call, see how much of what you say is in Japanese.' }));
    else {
      const drawn = drawRatioChart(calls);
      holder.replaceChildren(drawn.chart);
      attachRatioReadout(holder, drawn);
    }
  } else {
    $('progress-title').textContent = "Japanese you've spoken";
    $('progress-total').textContent = minutesText(progress.totalMinutes);
    $('progress-unit').textContent = 'min';
    if (!progress.points.length) {
      holder.replaceChildren(el('p', { className: 'muted', textContent: 'Your minutes of Japanese add up here, call by call.' }));
    } else {
      const drawn = drawChart(progress.points);
      holder.replaceChildren(drawn.chart);
      attachReadout(holder, drawn);
    }
  }
  renderLevel(progress);
}

export function initProgress() {
  for (const button of document.querySelectorAll('.progress-view')) button.addEventListener('click', () => chooseView(button.dataset.view));
}
