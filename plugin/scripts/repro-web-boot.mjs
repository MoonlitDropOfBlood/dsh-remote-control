// Reproduce the DSH web-boot client-module failure locally.
// Loads the REAL ClientModuleLoader from dsh-client-modules, registers the REAL
// client bundles of dsh-remote-control and dsh-token-stats, then materializes
// both with stubbed shell services to surface the actual error.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const DSH = 'C:/Users/wwhby/AppData/Roaming/DeepSeek Harness Desktop/dsh/node_modules';
const load = (p) => {
  const code = readFileSync(p, 'utf8');
  // each client bundle is a separate module scope in the browser — isolate consts
  vm.runInThisContext(`(function(){\n${code}\n})();`, { filename: p });
};

// 1) minimal browser globals
const styleRegistry = [];
globalThis.window = globalThis;
globalThis.document = {
  createElement: (tag) => {
    const el = { tag, _text: '', attrs: {}, children: [],
      set textContent(v) { this._text = v; }, get textContent() { return this._text; },
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); return c; } };
    return el;
  },
  head: { appendChild: (el) => { styleRegistry.push(el); } },
  querySelectorAll: () => [],
};
// the shell's primitive load(): a plain registry table
const table = new Map();
window.__ModuleLoader__ = {
  table,
  load(rec) { table.set(rec.id, rec); },
};

// 2) materialize the real loader implementation
load(`${DSH}/@deepseek-ai/dsh-client-modules/lib/client.js`);
const core = table.get('@deepseek-ai/dsh-client-modules');
console.log('core record?', !!core);

// The registration only stores a factory; materialize it manually.
const requireShim = (id) => {
  if (id === 'react') {
    return { createElement: (...a) => ({ a }), Fragment: 'f', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: () => ({ current: null }), useCallback: (f) => f, forwardRef: (f) => f, memo: (f) => f };
  }
  throw new Error(`requireShim: unresolved ${id}`);
};
const coreExports = core.factory(requireShim);
console.log('core exports:', Object.keys(coreExports));

// 3) register both plugin bundles with the real loader
load('D:/ai-projects/dsh/dsh-token-stats/client.js');
load('D:/ai-projects/dsh/dsh-remote-control/plugin/client.js');
console.log('both bundles registered; table size:', window.__ModuleLoader__.table ? window.__ModuleLoader__.table.size : '?');

// 4) materialize each with a stubbed cordis ctx
const makeCtx = (name) => {
  const log = (...a) => console.log(`[${name}]`, ...a);
  return {
    logger: { info: log, warn: log, error: log },
    slots: { inject: (slot, reg) => { log('slots.inject', slot, JSON.stringify(reg()).slice(0, 120)); return () => {}; } },
    remote: { $mount: async (contrib) => { log('$mount', Object.keys(contrib)); return async () => {}; } },
    get: () => null,
    on: () => () => {},
    effect: (f) => { const d = f(); return () => d?.(); },
  };
};
const table2 = window.__ModuleLoader__.table;
for (const id of ['@duke-dsh-plugins/dsh-token-stats', '@duke-dsh-plugins/dsh-remote-control']) {
  const rec = table2.get(id);
  if (!rec) { console.log('MISSING table record for', id); continue; }
  try {
    const ex = rec.factory(requireShim);
    const apply = ex.apply ?? ex.default?.apply;
    if (typeof apply === 'function') await apply(makeCtx(id), {});
    console.log('MATERIALIZED OK:', id, Object.keys(ex));
  } catch (e) {
    console.log('MATERIALIZATION FAILED:', id, '\n  ', e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n   ') : e);
  }
}

// 5) sharpest probe: the manifest parsers on BOTH real package.json dsh fields
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
for (const pkgPath of ['D:/ai-projects/dsh/dsh-token-stats/package.json', 'D:/ai-projects/dsh/dsh-remote-control/plugin/package.json']) {
  const pkg = req(pkgPath);
  try {
    const parsed = coreExports.parseDshClient(pkg.name, pkg.dsh?.client);
    console.log('parseDshClient OK:', pkg.name, JSON.stringify(parsed).slice(0, 200));
  } catch (e) {
    console.log('parseDshClient FAILED:', pkg.name, '\n  ', e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n   ') : e);
  }
}

// 6) COMBO SAFETY (production incident 2026-10-24): the web server concatenates
// all web client bundles into ONE <script> (buildComboScript, no scope wrap).
// Reproduce exactly that: compile our source + a foreign bundle that declares
// the same top-level names token-stats declares. Must PARSE cleanly.
{
  const ours = readFileSync('D:/ai-projects/dsh/dsh-remote-control/plugin/client.js', 'utf8');
  const foreign = 'const CLIENT_BUNDLE_ID = "@duke-dsh-plugins/dsh-token-stats";\nwindow.__ModuleLoader__.load({ id: CLIENT_BUNDLE_ID, factory: () => ({}) });\n';
  try {
    new vm.Script(foreign + ours, { filename: 'combo.js' });
    new vm.Script(ours + foreign, { filename: 'combo.js' });
    console.log('COMBO SAFE: our client.js parses in both concat orders alongside a bundle sharing its top-level names');
  } catch (e) {
    console.log('COMBO UNSAFE:', e.message);
    process.exitCode = 1;
  }
}
