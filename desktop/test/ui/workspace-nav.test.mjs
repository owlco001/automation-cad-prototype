import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceNav } from '../../src/ui/workspace-nav.ts';

// Minimal DOM fixture: exercise real event handlers without adding a browser dependency.
class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.textContent = '';
    this.id = '';
    this.className = '';
    this.classList = { toggle: (name, enabled) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (enabled) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
    } };
  }
  appendChild(child) { child.remove(); this.children.push(child); child.parent = this; return child; }
  insertBefore(child, before) {
    if (!before) return this.appendChild(child);
    child.remove(); this.children.splice(this.children.indexOf(before), 0, child); child.parent = this;
    return child;
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceChildren() { for (const child of [...this.children]) child.remove(); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  click() { if (!this.disabled) for (const handler of this.listeners.get('click') ?? []) handler(); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelector(selector) {
    const matches = node => {
      if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => node.className.split(' ').includes(name));
      const domain = selector.match(/^button\[data-domain="(.+)"\]$/);
      if (domain) return node.tagName === 'BUTTON' && node.dataset.domain === domain[1];
      return node.tagName.toLowerCase() === selector;
    };
    for (const child of this.children) {
      if (matches(child)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function fixture(t) {
  const body = new Element('body');
  body.dataset.domain = 'mech';
  const topbar = body.appendChild(new Element('header'));
  topbar.className = 'topbar';
  const modes = topbar.appendChild(new Element('nav'));
  modes.className = 'modes';
  const menu = topbar.appendChild(new Element('div'));
  menu.id = 'tbToolsMenu';
  menu.hidden = true;
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const oldDocument = globalThis.document;
  const oldObserver = globalThis.MutationObserver;
  globalThis.document = {
    body,
    createElement: tag => new Element(tag),
    querySelector: selector => body.querySelector(selector),
    getElementById: id => {
      const visit = node => node.id === id ? node : node.children.map(visit).find(Boolean);
      return visit(body) ?? null;
    }
  };
  globalThis.MutationObserver = Observer;
  t.after(() => {
    globalThis.document = oldDocument;
    globalThis.MutationObserver = oldObserver;
  });
  const domains = {};
  for (const domain of ['mech', 'elec']) {
    const button = topbar.appendChild(new Element('button'));
    button.dataset.domain = domain;
    button.addEventListener('click', () => { body.dataset.domain = domain; });
    domains[domain] = button;
  }
  function tool(id, label) {
    const button = menu.appendChild(new Element('button'));
    button.id = id;
    button.textContent = label;
    return button;
  }
  return { body, topbar, modes, menu, domains, tool, observers };
}

test('four workflow buttons select existing domains, update accessibility and notify once', async t => {
  const f = fixture(t);
  const changes = [];
  const nav = installWorkspaceNav({ onWorkspaceChange: key => changes.push(key) });
  const root = document.getElementById('workspaceNav');
  assert.equal(f.topbar.children.indexOf(root), f.topbar.children.indexOf(f.modes) - 1);
  const tabs = root.children[0].children;
  assert.deepEqual(tabs.map(button => button.textContent), ['设计装配', '电气设计', 'PLC与联调', '校核与交付']);
  tabs[2].click();
  await Promise.resolve();
  assert.equal(f.body.dataset.domain, 'elec');
  assert.equal(tabs[2].getAttribute('aria-current'), 'page');
  assert.equal(tabs[0].getAttribute('aria-pressed'), 'false');
  assert.deepEqual(changes, ['plc']);
  nav.setActive('delivery');
  assert.equal(f.body.dataset.domain, 'mech');
  assert.equal(tabs[3].getAttribute('aria-current'), 'page');
  nav.dispose();
});

test('shortcuts omit unavailable modules, keep original menu nodes and resolve live IDs', t => {
  const f = fixture(t);
  const original = f.tool('designWizardEntry', '整机设计');
  const disabled = f.tool('assemblyEntryButton', '装配');
  disabled.disabled = true;
  const hidden = f.tool('machineLibraryEntryButton', '机型库');
  hidden.hidden = true;
  let clicks = 0;
  original.addEventListener('click', () => clicks++);
  const nav = installWorkspaceNav();
  const strip = document.getElementById('workspaceToolStrip');
  assert.deepEqual(strip.children.map(button => button.textContent), ['整机设计']);
  assert.equal(original.parent, f.menu);
  strip.children[0].click();
  assert.equal(clicks, 1);
  original.remove();
  const replacement = f.tool('designWizardEntry', '新设计入口');
  replacement.addEventListener('click', () => clicks += 10);
  strip.children[0].click();
  assert.equal(clicks, 11);
  replacement.disabled = true;
  nav.refresh();
  assert.equal(strip.hidden, true);
  assert.equal(strip.children.length, 0);
  nav.dispose();
});

test('external domain changes refresh context; mutations are debounced and own changes ignored', async t => {
  const f = fixture(t);
  const nav = installWorkspaceNav();
  const root = document.getElementById('workspaceNav');
  const observer = f.observers[0];
  f.body.dataset.domain = 'elec';
  f.tool('elecLibEntryButton', '电气元件');
  observer.callback([{ target: f.body }, { target: f.menu }]);
  await Promise.resolve();
  assert.equal(root.dataset.workspace, 'electrical');
  const strip = document.getElementById('workspaceToolStrip');
  const shortcut = strip.children[0];
  observer.callback([{ target: shortcut }]);
  await Promise.resolve();
  assert.equal(strip.children[0], shortcut);
  nav.dispose();
  assert.equal(observer.disconnected, true);
  assert.equal(document.getElementById('workspaceNav'), null);
  nav.setActive('design');
  nav.refresh();
  assert.equal(f.body.dataset.domain, 'elec');
});
