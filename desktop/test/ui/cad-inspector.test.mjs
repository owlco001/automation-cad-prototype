import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installCadInspector, planCadInspectorSelection } from '../../src/ui/cad-inspector.ts';

// Only the DOM surface used by this controller; no browser or new package is required.
function harness() {
  const observers = new Set();
  class Observer {
    records = [];
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); this.records = []; }
    flush() {
      const records = this.records.splice(0);
      if (records.length) this.callback(records);
    }
  }
  const document = { defaultView: { MutationObserver: Observer }, activeElement: null };
  class Element {
    attrs = new Map();
    children = [];
    listeners = new Map();
    classes = new Set();
    _hidden = false;
    disabled = false;
    constructor() {
      this.ownerDocument = document;
      this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    get id() { return this.attrs.get('id') ?? ''; }
    set id(value) { this.attrs.set('id', value); }
    get hidden() { return this._hidden; }
    set hidden(value) {
      this._hidden = value;
      for (const observer of observers) observer.records.push({ type: 'attributes', target: this });
    }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    removeAttribute(name) { this.attrs.delete(name); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    insertBefore(child, before) {
      child.parentNode = this;
      this.children.splice(this.children.indexOf(before), 0, child);
    }
    remove() { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
    querySelector(selector) {
      for (const child of this.children) {
        if (selector.startsWith('#') ? child.id === selector.slice(1) : child.className === selector.slice(1)) return child;
        const descendant = child.querySelector(selector);
        if (descendant) return descendant;
      }
      return null;
    }
    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
    }
    removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
    dispatch(name, fields = {}) {
      const event = { preventDefault() { this.prevented = true; }, stopPropagation() {}, ...fields };
      for (const listener of this.listeners.get(name) ?? []) listener(event);
      return event;
    }
    focus() { document.activeElement = this; }
  }
  document.createElement = () => new Element();
  const root = new Element();
  const main = root.appendChild(new Element());
  main.className = 'cad-main';
  const inspection = main.appendChild(new Element());
  inspection.className = 'cad-inspector';
  const kinematics = main.appendChild(new Element());
  kinematics.id = 'cadKinematicsDrawer';
  kinematics.hidden = true;
  const parametric = main.appendChild(new Element());
  parametric.id = 'cadParametricDrawer';
  parametric.hidden = true;
  const calls = [];
  let enabled = true;
  let callback = (key) => calls.push(key);
  const controller = installCadInspector({ root, isParametricEnabled: () => enabled, onSelect: (key) => callback(key) });
  const nav = root.children[0];
  const button = (key) => nav.children.find((item) => item.getAttribute('data-cad-inspector-tab') === key);
  const visible = () => [inspection, kinematics, parametric].map((panel) => !panel.hidden);
  return {
    root, main, inspection, kinematics, parametric, controller, nav, button, calls, visible, document,
    setEnabled(value) { enabled = value; },
    setCallback(value) { callback = value; },
    flush() { for (const observer of [...observers]) observer.flush(); },
    pending() { return [...observers].reduce((count, observer) => count + observer.records.length, 0); }
  };
}

test('selection model is exclusive and disabled parametric falls back to inspection', () => {
  for (const key of ['inspection', 'kinematics', 'parametric', 'collapsed']) {
    const plan = planCadInspectorSelection(key, true);
    assert.equal(plan.selected, key);
    assert.equal([plan.inspection, plan.kinematics, plan.parametric].filter(Boolean).length, key === 'collapsed' ? 0 : 1);
  }
  assert.deepEqual(planCadInspectorSelection('parametric', false), {
    selected: 'inspection', inspection: true, kinematics: false, parametric: false
  });
});

test('mounts before main, preserves nodes, exposes ARIA relationships and selects exclusively', () => {
  const h = harness();
  assert.equal(h.root.children[1], h.main);
  assert.equal(h.nav.className, 'cad-inspector-tabs');
  assert.equal(h.nav.getAttribute('role'), 'tablist');
  assert.deepEqual(h.nav.children.map((button) => button.textContent), ['检查', '运动学', '参数化', '收起']);
  assert.equal(h.button('inspection').getAttribute('aria-controls'), h.inspection.id);
  assert.equal(h.inspection.getAttribute('aria-labelledby'), h.button('inspection').id);
  assert.equal(h.inspection.parentNode, h.main);
  for (const [key, expected] of [
    ['kinematics', [false, true, false]], ['parametric', [false, false, true]],
    ['inspection', [true, false, false]], ['collapsed', [false, false, false]]
  ]) {
    h.controller.select(key);
    assert.deepEqual(h.visible(), expected);
    assert.equal(h.button(key).getAttribute('aria-selected'), 'true');
    assert.equal(h.button(key).tabIndex, 0);
    assert.equal(h.root.getAttribute('data-cad-inspector-panel'), key);
  }
  assert.deepEqual(h.calls, ['kinematics', 'parametric']);
});

test('failed callbacks restore the previous panel even after mutating drawers', () => {
  const h = harness();
  h.controller.select('kinematics');
  h.setCallback(() => {
    h.kinematics.hidden = true;
    h.parametric.hidden = false;
    throw new Error('open failed');
  });
  assert.throws(() => h.controller.select('parametric'), /open failed/);
  assert.deepEqual(h.visible(), [false, true, false]);
  assert.equal(h.button('kinematics').getAttribute('aria-selected'), 'true');
  h.flush();
  assert.deepEqual(h.visible(), [false, true, false]);
});

test('external drawer open and close synchronize selection without callbacks or observer loops', () => {
  const h = harness();
  h.kinematics.hidden = false;
  h.flush();
  assert.deepEqual(h.visible(), [false, true, false]);
  assert.equal(h.button('kinematics').getAttribute('aria-selected'), 'true');
  h.kinematics.hidden = true;
  h.parametric.hidden = false;
  h.flush();
  assert.deepEqual(h.visible(), [false, false, true]);
  h.parametric.hidden = true;
  h.flush();
  assert.deepEqual(h.visible(), [true, false, false]);
  assert.deepEqual(h.calls, []);
  assert.equal(h.pending(), 0);
});

test('disabling parametric hides its tab and restores inspection without opening another drawer', () => {
  const h = harness();
  h.controller.select('parametric');
  h.setEnabled(false);
  h.controller.refresh();
  assert.equal(h.button('parametric').hidden, true);
  assert.equal(h.button('parametric').disabled, true);
  assert.deepEqual(h.visible(), [true, false, false]);
  h.controller.select('parametric');
  assert.deepEqual(h.calls, ['parametric']);
  h.parametric.hidden = false;
  h.flush();
  assert.deepEqual(h.visible(), [true, false, false]);
  h.setEnabled(true);
  h.controller.refresh();
  assert.equal(h.button('parametric').hidden, false);
});

test('arrow, home and end keys wrap and skip disabled tabs with roving focus', () => {
  const h = harness();
  h.setEnabled(false);
  h.controller.refresh();
  const event = h.button('inspection').dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(event.prevented, true);
  assert.equal(h.document.activeElement, h.button('collapsed'));
  h.button('collapsed').dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(h.document.activeElement, h.button('inspection'));
  h.button('inspection').dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(h.document.activeElement, h.button('kinematics'));
  h.button('kinematics').dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(h.document.activeElement, h.button('collapsed'));
  h.button('collapsed').dispatch('keydown', { key: 'Home' });
  assert.equal(h.document.activeElement, h.button('inspection'));
  h.button('inspection').dispatch('keydown', { key: 'End' });
  assert.equal(h.document.activeElement, h.button('collapsed'));
});

test('dispose removes controller listeners and metadata without replacing or hiding panels', () => {
  const h = harness();
  h.controller.select('kinematics');
  h.controller.dispose();
  h.controller.dispose();
  assert.equal(h.root.children[0], h.main);
  assert.equal(h.inspection.getAttribute('id'), null);
  assert.equal(h.inspection.getAttribute('role'), null);
  assert.equal(h.root.getAttribute('data-cad-inspector-panel'), null);
  h.button('parametric').dispatch('click');
  h.controller.select('inspection');
  assert.deepEqual(h.visible(), [false, true, false]);
  assert.deepEqual(h.calls, ['kinematics']);
});
