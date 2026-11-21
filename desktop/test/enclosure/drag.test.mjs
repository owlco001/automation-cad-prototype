import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../../src/enclosure/canvas.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'Enclosure',
  plugins: [{ name: 'browser-assets', setup(builder) {
    builder.onResolve({ filter: /enclosure\.css\?inline$/ }, () => ({ path: 'styles', namespace: 'stub' }));
    builder.onResolve({ filter: /\/ui\/panels$/ }, () => ({ path: 'panels', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: path === 'styles'
      ? 'export default "";'
      : 'export const escapeHtml = (s) => String(s); export const notify = () => {}; export const ensurePanelStyles = () => {}; export const buildEntryButton = () => null;' }));
  } }]
});

class ElementStub {
  listeners = new Map();
  attributes = new Map();
  dataset = {};
  style = {};
  classList = { add() {}, remove() {}, toggle() {} };
  clientWidth = 1000;
  clientHeight = 1000;
  captures = new Set();
  markup = '';
  renders = 0;
  focusCount = 0;
  set innerHTML(value) { this.markup = value; this.renders++; }
  get innerHTML() { return this.markup; }
  addEventListener(type, callback, options = {}) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(callback);
    this.listeners.set(type, set);
    options.signal?.addEventListener('abort', () => set.delete(callback), { once: true });
  }
  emit(type, input = {}) {
    const event = { button: 0, pointerId: 1, clientX: 0, clientY: 0, target: this, preventDefault() {}, ...input };
    for (const callback of [...(this.listeners.get(type) ?? [])]) callback(event);
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  closest(selector) { return selector === this.match ? this : null; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) {
    this.captures.delete(id);
    this.emit('lostpointercapture', { pointerId: id });
  }
  createSVGPoint() { return { x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } }; }
  getScreenCTM() { return { inverse() {} }; }
  focus() { this.focusCount++; }
}

function fixture() {
  const nodes = new Map();
  const host = new ElementStub();
  host.querySelector = (key) => {
    if (!nodes.has(key)) nodes.set(key, new ElementStub());
    return nodes.get(key);
  };
  host.querySelectorAll = () => [];
  const initial = {
    version: 1, plate: { width: 600, height: 800, rails: [
      { id: 'r1', y: 100, height: 35, label: 'Rail 1' }, { id: 'r2', y: 300, height: 35, label: 'Rail 2' }
    ] }, placements: [
      { id: 'p1', partId: 'A', model: 'A', x: 10, y: 100, w: 20, h: 20, railId: 'r1' },
      { id: 'p2', partId: 'B', model: 'B', x: 50, y: 100, w: 20, h: 20 }
    ]
  };
  const writes = [];
  const frames = new Map();
  let sequence = 0;
  let disconnected = false;
  const window = new ElementStub();
  window.localStorage = { getItem: () => JSON.stringify(initial), setItem: (key, text) => writes.push(JSON.parse(text)) };
  window.requestAnimationFrame = (callback) => { frames.set(++sequence, callback); return sequence; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  const context = vm.createContext({ window, console, AbortController, Element: ElementStub,
    ResizeObserver: class { observe() {} disconnect() { disconnected = true; } }
  });
  vm.runInContext(compiled.outputFiles[0].text, context);
  const canvas = new context.Enclosure.EnclosureCanvas(host);
  const svg = nodes.get('#encSvg');
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()); };
  canvas.setActive(true);
  flush();
  const start = (kind = 'part', id = 'p1', x = 10, y = 100) => {
    const target = new ElementStub();
    target.match = kind === 'part' ? '[data-enc-part]' : '[data-enc-rail]';
    target.setAttribute(kind === 'part' ? 'data-enc-part' : 'data-enc-rail', id);
    svg.emit('pointerdown', { target, clientX: x, clientY: y });
  };
  return { canvas, svg, window, nodes, frames, writes, flush, start, disconnected: () => disconnected };
}

test('drag coalesces rendering, keeps live state, and persists pointerup final coordinates once', () => {
  const f = fixture();
  f.start();
  const renders = f.svg.renders;
  f.svg.emit('pointermove', { clientX: 30, clientY: 100 });
  f.svg.emit('pointermove', { clientX: 50, clientY: 100 });
  assert.equal(f.canvas.state().placements[0].x, 50);
  assert.equal(f.frames.size, 1);
  assert.equal(f.svg.renders, renders);
  assert.equal(f.writes.length, 0);
  f.flush();
  assert.equal(f.svg.renders, renders + 1);
  assert.equal(f.nodes.get('#encCanvasRoot').dataset.collisions, '1');
  f.svg.emit('pointermove', { clientX: 60, clientY: 100 });
  f.svg.emit('pointerup', { clientX: 80, clientY: 100 });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].placements[0].x, 80);
  assert.equal(f.frames.size, 0);
  assert.equal(f.svg.captures.size, 0);
  assert.match(f.svg.innerHTML, /translate\(80 100\)/);
  const finalRenders = f.svg.renders;
  f.flush();
  assert.equal(f.svg.renders, finalRenders);
});

test('100 pointermove in one frame produce one render and one release persistence', () => {
  const f = fixture();
  f.start();
  const renders = f.svg.renders;
  for (let index = 1; index <= 100; index += 1) {
    f.svg.emit('pointermove', { clientX: 10 + index, clientY: 100 });
  }
  assert.equal(f.canvas.state().placements[0].x, 110);
  assert.equal(f.frames.size, 1);
  assert.equal(f.svg.renders, renders);
  assert.equal(f.writes.length, 0);
  f.flush();
  assert.equal(f.svg.renders, renders + 1);
  f.svg.emit('pointerup', { clientX: 110, clientY: 100 });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].placements[0].x, 110);
  assert.equal(f.frames.size, 0);
});

test('snapped/clamped no-op moves and clicks do not queue frames or persist', () => {
  const f = fixture();
  f.start();
  const renders = f.svg.renders;
  f.svg.emit('pointermove', { clientX: 10.1, clientY: 100.2 });
  f.svg.emit('pointerup', { clientX: 10, clientY: 100 });
  assert.equal(f.frames.size, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.svg.renders, renders);
  f.start();
  f.svg.emit('pointermove', { clientX: -100, clientY: 100 });
  f.flush();
  const atBoundary = f.svg.renders;
  f.svg.emit('pointermove', { clientX: -200, clientY: 100 });
  assert.equal(f.frames.size, 0);
  assert.equal(f.svg.renders, atBoundary);
  f.svg.emit('pointerup', { clientX: -300, clientY: 100 });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].placements[0].x, 0);
});

for (const end of ['pointercancel', 'lostpointercapture', 'close', 'dispose']) {
  test(`${end} saves latest valid state and cancels render/focus callbacks`, () => {
    const f = fixture();
    f.start();
    f.svg.emit('pointermove', { clientX: 40, clientY: 100 });
    if (end === 'close' || end === 'dispose') f.canvas.setActive(true);
    if (end === 'close') f.canvas.setActive(false);
    else if (end === 'dispose') f.canvas.dispose();
    else f.svg.emit(end, { clientX: 999, clientY: 999 });
    assert.equal(f.frames.size, 0);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].placements[0].x, 40);
    assert.equal(f.svg.captures.size, 0);
    f.svg.emit('pointerup', { clientX: 200, clientY: 200 });
    assert.equal(f.writes.length, 1);
    if (end === 'dispose') {
      assert.equal(f.disconnected(), true);
      assert.equal([...f.window.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0);
      assert.equal([...f.svg.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0);
      f.canvas.dispose();
      f.canvas.setActive(true);
      assert.equal(f.frames.size, 0);
    }
  });
}

test('rail drag moves attached parts only and flushes a release without a prior move', () => {
  const f = fixture();
  f.start('rail', 'r1', 0, 100);
  f.svg.emit('pointerup', { clientX: 0, clientY: 145 });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].plate.rails[0].y, 145);
  assert.equal(f.writes[0].placements[0].y, 145);
  assert.equal(f.writes[0].placements[1].y, 100);
  assert.equal(f.frames.size, 0);
});
