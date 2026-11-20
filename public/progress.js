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

export function renderProgress() {
  const progress = state.me.progress ?? { points: [], totalMinutes: 0, speakingLevel: null, gradedCalls: 0, callsUntilLevel: 5 };
  $('progress-total').textContent = minutesText(progress.totalMinutes);
  const holder = $('progress-chart');
  if (!progress.points.length) {
    holder.replaceChildren(el('p', { className: 'muted', textContent: 'Your minutes of Japanese add up here, call by call.' }));
  } else {
    const drawn = drawChart(progress.points);
    holder.replaceChildren(drawn.chart);
    attachReadout(holder, drawn);
  }
  renderLevel(progress);
}
