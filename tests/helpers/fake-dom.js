// fake-dom.js — Minimal DOM double for side-panel component tests.
//
// Supports the subset the components use: element creation, tree mutation,
// classList/dataset/attributes, bubbling events with stopPropagation /
// preventDefault, focus tracking, DocumentFragment, and querySelector(All)
// for simple compound selectors (tag, #id, .class, [attr], [attr="v"],
// :checked) joined by descendant combinators.

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.set = new Set();
  }
  add(...names) { for (const n of names) this.set.add(n); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
}

function parseCompound(text) {
  const parts = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:([\w-]+)/g;
  let match;
  while ((match = re.exec(text))) {
    if (match[1]) parts.tag = match[1].toUpperCase();
    else if (match[2]) parts.id = match[2];
    else if (match[3]) parts.classes.push(match[3]);
    else if (match[4]) parts.attrs.push([match[4], match[5]]);
    else if (match[6]) parts.pseudos.push(match[6]);
  }
  return parts;
}

function matchesCompound(el, parts) {
  if (!(el instanceof FakeElement) || el.isFragment) return false;
  if (parts.tag && el.tagName !== parts.tag) return false;
  if (parts.id && el.id !== parts.id) return false;
  for (const c of parts.classes) if (!el.classList.contains(c)) return false;
  for (const [name, value] of parts.attrs) {
    const actual = el.getAttribute(name);
    if (actual === null) return false;
    if (value !== undefined && actual !== value) return false;
  }
  for (const p of parts.pseudos) {
    if (p === 'checked' && !el.checked) return false;
  }
  return true;
}

function matchesSelector(el, selector) {
  return selector.split(',').some((single) => {
    const chain = single.trim().split(/\s+/).map(parseCompound);
    if (!matchesCompound(el, chain[chain.length - 1])) return false;
    let cursor = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      while (cursor && !matchesCompound(cursor, chain[i])) cursor = cursor.parentNode;
      if (!cursor) return false;
      cursor = cursor.parentNode;
    }
    return true;
  });
}

export class FakeElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.tagName = String(tagName).toUpperCase();
    this.isFragment = tagName === '#fragment';
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList(this);
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this._text = '';
    this._html = '';
  }

  get className() { return [...this.classList.set].join(' '); }
  set className(value) {
    this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get id() { return this.attributes.get('id') ?? ''; }
  set id(value) { this.attributes.set('id', String(value)); }

  get tabIndex() {
    const raw = this.attributes.get('tabindex');
    if (raw !== undefined) return Number(raw);
    return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(this.tagName) ? 0 : -1;
  }
  set tabIndex(value) { this.attributes.set('tabindex', String(value)); }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
    this._text = String(value ?? '');
    this._html = '';
  }

  get innerHTML() { return this._html || this._text; }
  set innerHTML(value) {
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
    this._html = String(value ?? '');
    this._text = this._html.replace(/<[^>]*>/g, '');
  }

  get isConnected() {
    let cursor = this;
    while (cursor.parentNode) cursor = cursor.parentNode;
    return cursor === this.ownerDocument.body;
  }

  get firstElementChild() { return this.children[0] ?? null; }

  setAttribute(name, value) {
    if (name === 'class') this.className = value;
    else this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    if (name === 'class') return this.className || null;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return key in this.dataset ? String(this.dataset[key]) : null;
    }
    if (name === 'type' && !this.attributes.has('type') && this.type !== undefined) return String(this.type);
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { this.attributes.delete(name); }

  appendChild(child) {
    if (child.isFragment) {
      for (const grandChild of [...child.children]) this.appendChild(grandChild);
      return child;
    }
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    this._text = '';
    this._html = '';
    return child;
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) {
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
    this._text = '';
    this._html = '';
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }
  after(node) {
    const parent = this.parentNode;
    if (!parent) return;
    node.remove();
    const index = parent.children.indexOf(this);
    parent.children.splice(index + 1, 0, node);
    node.parentNode = parent;
  }
  contains(node) {
    for (let cursor = node; cursor; cursor = cursor.parentNode) {
      if (cursor === this) return true;
    }
    return false;
  }
  closest(selector) {
    for (let cursor = this; cursor instanceof FakeElement; cursor = cursor.parentNode) {
      if (matchesSelector(cursor, selector)) return cursor;
    }
    return null;
  }
  matches(selector) { return matchesSelector(this, selector); }

  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
  querySelectorAll(selector) {
    return [...this.descendants()].filter((el) => matchesSelector(el, selector));
  }
  querySelector(selector) {
    for (const el of this.descendants()) if (matchesSelector(el, selector)) return el;
    return null;
  }

  addEventListener(type, listener, options) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ listener, capture, once: Boolean(options?.once) });
  }
  removeEventListener(type, listener, options) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.findIndex((entry) => entry.listener === listener && entry.capture === capture);
    if (index >= 0) list.splice(index, 1);
  }
  _invoke(event, phase) {
    const list = [...(this.listeners.get(event.type) || [])];
    for (const entry of list) {
      if (phase === 'capture' && !entry.capture) continue;
      if (phase === 'bubble' && entry.capture) continue;
      if (entry.once) this.removeEventListener(event.type, entry.listener, { capture: entry.capture });
      event.currentTarget = this;
      entry.listener.call(this, event);
    }
  }
  dispatchEvent(event) {
    event.target = this;
    const path = [];
    for (let cursor = this.parentNode; cursor; cursor = cursor.parentNode) path.push(cursor);
    if (this.ownerDocument && path[path.length - 1] === this.ownerDocument.body) {
      path.push(this.ownerDocument.documentElement, this.ownerDocument);
    }
    for (const node of [...path].reverse()) {
      if (event._stopped) break;
      node._invoke(event, 'capture');
    }
    if (!event._stopped) this._invoke(event, 'target');
    if (event.bubbles !== false) {
      for (const node of path) {
        if (event._stopped) break;
        node._invoke(event, 'bubble');
      }
    }
    return !event.defaultPrevented;
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent(createEvent('click'));
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }
  scrollIntoView() {}
}

export function createEvent(type, init = {}) {
  return {
    type,
    bubbles: init.bubbles ?? true,
    key: init.key,
    shiftKey: Boolean(init.shiftKey),
    ctrlKey: Boolean(init.ctrlKey),
    metaKey: Boolean(init.metaKey),
    altKey: Boolean(init.altKey),
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    _stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stopped = true; },
    stopImmediatePropagation() { this._stopped = true; },
  };
}

export function keydown(target, key, modifiers = {}) {
  const event = createEvent('keydown', { key, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

class FakeDocument extends FakeElement {
  constructor() {
    super(null, '#document');
    this.ownerDocument = this;
    this.isFragment = false;
    this.documentElement = new FakeElement(this, 'html');
    this.body = new FakeElement(this, 'body');
    this.body.parentNode = null;
    this.activeElement = this.body;
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createDocumentFragment() { return new FakeElement(this, '#fragment'); }
  getElementById(id) {
    if (this.body.id === id) return this.body;
    return this.body.querySelector(`#${id}`);
  }
  querySelector(selector) { return this.body.querySelector(selector); }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  _invoke(event, phase) { FakeElement.prototype._invoke.call(this, event, phase); }
}

/**
 * Install a fresh fake document on globalThis. Returns { document, restore }.
 */
export function installFakeDom() {
  const saved = {};
  for (const key of ['document', 'requestAnimationFrame', 'CustomEvent']) {
    saved[key] = { had: Object.hasOwn(globalThis, key), value: globalThis[key] };
  }
  const document = new FakeDocument();
  globalThis.document = document;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.CustomEvent = class {
    constructor(type, init = {}) {
      Object.assign(this, createEvent(type));
      this.detail = init.detail;
    }
  };
  return {
    document,
    el(tag, { id, className, parent } = {}) {
      const element = document.createElement(tag);
      if (id) element.id = id;
      if (className) element.className = className;
      (parent || document.body).appendChild(element);
      return element;
    },
    restore() {
      for (const [key, { had, value }] of Object.entries(saved)) {
        if (had) globalThis[key] = value;
        else delete globalThis[key];
      }
    },
  };
}
