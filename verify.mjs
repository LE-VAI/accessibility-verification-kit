#!/usr/bin/env node
/**
 * Accessibility verification kit: one URL in, one report out.
 *
 *   node verify.mjs <url | local .html file> [options]
 *
 *   --out <dir>        where the report folder goes (default ./verification-report)
 *   --browser <path>   a Chromium-family browser to use (or set CHROME_PATH)
 *   --budget <s>       seconds to wait for the page to settle (default 6)
 *   --settle <s>       extra seconds after it settles, before the rules run (default 3)
 *   --no-contract      skip the design-contract engine
 *   --attach <port>    scan inside a browser you already opened with a DevTools
 *                      port on this machine, instead of launching a headless one
 *   --json             print the full report as JSON instead of the summary
 *
 * Needs Node 22 or newer (for the built-in WebSocket) and Chrome, Edge,
 * Chromium or Brave. Nothing to install: the rules engine ships in engine/ and
 * is checked against its pinned SHA-256 before every run. The design-contract
 * engine is fetched by npx on first use.
 *
 * Exit codes: 0 no automated violations, 1 violations found, 2 a WCAG number
 * was withheld (the report says why), 3 the run could not start.
 *
 * Read METHOD.md before trusting a number this prints.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, platform, tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { argv, env, execPath, exit, stdout, versions } from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const KIT = { name: 'accessibility-verification-kit', version: '1.0.0' };

// The rules engine. The hash is the npm registry copy of axe-core 4.13.0
// (package/axe.min.js in axe-core-4.13.0.tgz); jsDelivr serves the same bytes.
const AXE = {
  version: '4.13.0',
  file: join('engine', 'axe.min.js'),
  sha256: 'c24f097bd2f451d4f933e8bc7d8d539f8672a2ebcb5cc9f9f3eec8ca9470a0c1',
  tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
};

const CONTRACT = { pkg: 'designesy-score', version: '1.0.4', scope: 'universal' };

// 1280 is a desktop window; 320 is the width WCAG 1.4.10 (Reflow) is written for.
const VIEWPORTS = [
  { label: 'desktop', width: 1280, height: 900 },
  { label: 'reflow', width: 320, height: 640 },
];

const NOT_MEASURED = [
  'whether people using assistive technology can complete the task the entry exists for',
  'whether text alternatives, headings, labels and error messages mean what they say',
  'anything behind an interaction: menus, dialogs, forms, states after sign-in',
  'pages other than the one scanned',
  'keyboard use across a whole task: focus order, traps, visible focus',
  'what a screen reader announces',
  'cognitive load, plain language, captions quality',
  'speed (Core Web Vitals need field data)',
];

// ---------------------------------------------------------------------------
// In-page code
// ---------------------------------------------------------------------------

// Is the DOM worth auditing yet? A skeleton page reports readyState 'complete'
// with almost nothing in it, so the element count is part of the answer.
const READY_JS = String.raw`
(() => {
  const body = document.body;
  return {
    readyState: document.readyState,
    bodyElements: body ? body.querySelectorAll('*').length : 0
  };
})()
`;

const RUN_JS = String.raw`
(async () => {
  if (typeof axe === 'undefined') return { err: 'axe not loaded' };
  try {
    const r = await axe.run(document, {
      runOnly: { type: 'tag', values: __TAGS__ }
    });
    const sample = (n) => ({
      target: (n.target || []).join(' '),
      html: (n.html || '').slice(0, 160),
      summary: (n.failureSummary || '').slice(0, 240)
    });
    const detail = (x) => ({
      id: x.id, impact: x.impact, help: x.help, helpUrl: x.helpUrl,
      tags: x.tags.filter(t => /^wcag\d/.test(t)),
      nodes: x.nodes.length,
      samples: x.nodes.slice(0, 5).map(sample)
    });
    const counts = {};
    r.violations.forEach(x => { counts[x.impact] = (counts[x.impact] || 0) + 1; });
    return {
      url: location.href,
      engine: r.testEngine,
      passes: r.passes.length,
      violations: r.violations.length,
      incomplete: r.incomplete.length,
      inapplicable: r.inapplicable.length,
      byImpact: counts,
      detail: r.violations.map(detail),
      needsReview: r.incomplete.map(detail),
      ruleIds: {
        passes: r.passes.map(x => x.id),
        violations: r.violations.map(x => x.id),
        incomplete: r.incomplete.map(x => x.id),
        inapplicable: r.inapplicable.map(x => x.id)
      }
    };
  } catch (e) { return { err: String(e) }; }
})()
`.replace('__TAGS__', JSON.stringify(AXE.tags));

// Rendered measurements. The target logic follows WCAG 2.5.8: a target inside
// a line of other text is exempt; a standalone link in a list is not.
const MEASURE_JS = String.raw`
(() => {
  const out = {};
  const sel = 'a[href], button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
  const targets = [];
  document.querySelectorAll(sel).forEach(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (r.width === 0 && r.height === 0) return;
    const tag = el.tagName.toLowerCase();
    const isLink = tag === 'a' && el.hasAttribute('href');
    const inlineLevel = cs.display === 'inline' || cs.display === 'inline-block';
    const block = el.parentElement && el.parentElement.closest('p, li, td, dd, blockquote, figcaption, article, .prose');
    const own = (el.innerText || '').trim();
    const around = block ? (block.innerText || '').trim() : '';
    const exempt = isLink && inlineLevel && !!block && around.length > own.length;
    targets.push({
      tag: tag,
      text: (own || el.getAttribute('aria-label') || '').slice(0, 40),
      w: Math.round(r.width), h: Math.round(r.height),
      inline_exempt: exempt
    });
  });
  out.targets = targets.length;
  out.targets_below_24 = targets.filter(t => !t.inline_exempt && (t.w < 24 || t.h < 24));
  out.targets_below_44 = targets.filter(t => !t.inline_exempt && (t.w < 44 || t.h < 44));
  out.inline_exempt = targets.filter(t => t.inline_exempt).length;

  out.inputs = [...document.querySelectorAll('input, select, textarea')]
    .filter(el => el.type !== 'hidden')
    .map(el => ({ tag: el.tagName.toLowerCase(), type: el.type || null,
                  fontSizePx: parseFloat(getComputedStyle(el).fontSize) || null }));
  out.textEntry = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"])' +
    ':not([type="checkbox"]):not([type="radio"]):not([type="image"]):not([type="file"])' +
    ':not([type="range"]):not([type="color"]), textarea, [contenteditable=""],' +
    ' [contenteditable="true"], [role="textbox"]').length;
  out.frames = document.querySelectorAll('iframe, frame, object, embed').length;

  // Characters per line for paragraphs: the rendered width over half the font
  // size, capped by the paragraph's own length, so a one-line credit in a wide
  // box is not reported as a long line.
  const prose = [];
  document.querySelectorAll('p').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 40) return;
    const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
    const text = (el.innerText || '').trim();
    const approxCh = Math.round(r.width / (fs * 0.5));
    prose.push({ w: Math.round(r.width), fontSizePx: fs, approxCh: approxCh,
                 chars: text.length, lineCh: Math.min(approxCh, text.length),
                 text: text.slice(0, 50) });
  });
  out.paragraphs = prose.length;
  out.proseOver75 = prose.filter(p => p.lineCh > 75);

  const de = document.documentElement;
  out.viewport = { w: innerWidth, h: innerHeight };
  out.overflowX = Math.max(0, de.scrollWidth - de.clientWidth);
  out.lang = de.getAttribute('lang');
  out.title = document.title;
  return out;
})()
`;

// What is still moving? Run once as the page loaded, and again after the
// browser is told the visitor prefers reduced motion.
const MOTION_JS = String.raw`
(() => {
  const all = document.getAnimations ? document.getAnimations() : [];
  const running = all.filter(a => a.playState === 'running');
  const timing = a => (a.effect && a.effect.getTiming) ? a.effect.getTiming() : {};
  const infinite = running.filter(a => timing(a).iterations === Infinity);
  return {
    reduceMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
    running: running.length,
    infinite: infinite.length,
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    sample: running.slice(0, 8).map(a => ({
      kind: a.constructor ? a.constructor.name : 'Animation',
      name: a.animationName || a.transitionProperty || a.id || '',
      iterations: timing(a).iterations === Infinity ? 'infinite' : timing(a).iterations,
      target: (a.effect && a.effect.target && a.effect.target.tagName || '').toLowerCase()
    }))
  };
})()
`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoLocal(d = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

function stampFor(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function slugFor(url) {
  const u = new URL(url);
  const rest = (u.host || 'local') + (u.pathname === '/' ? '' : u.pathname);
  return rest.toLowerCase().replace(/[^a-z0-9.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'page';
}

function fail(message, code = 3) {
  console.error(`verify: ${message}`);
  exit(code);
}

function parseArgs(args) {
  const opts = { target: null, out: 'verification-report', browser: env.CHROME_PATH || null,
                 budget: 6, settle: 3, contract: true, json: false, attach: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      if (i + 1 >= args.length) fail(`${a} needs a value`);
      return args[++i];
    };
    if (a === '--out') opts.out = next();
    else if (a === '--browser') opts.browser = next();
    else if (a === '--budget') opts.budget = Number(next());
    else if (a === '--settle') opts.settle = Number(next());
    else if (a === '--no-contract') opts.contract = false;
    else if (a === '--json') opts.json = true;
    else if (a === '--attach') opts.attach = next();
    else if (a === '-h' || a === '--help') { printHelp(); exit(0); }
    else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else if (opts.target) fail('one target per run');
    else opts.target = a;
  }
  if (!opts.target) { printHelp(); exit(3); }
  for (const k of ['budget', 'settle']) {
    if (!Number.isFinite(opts[k]) || opts[k] < 0 || opts[k] > 120) fail(`--${k} must be 0 to 120 seconds`);
  }
  return opts;
}

function printHelp() {
  console.log([
    'usage: node verify.mjs <url | local .html file> [options]',
    '',
    '  --out <dir>        where the report folder goes (default ./verification-report)',
    '  --browser <path>   a Chromium-family browser to use (or set CHROME_PATH)',
    '  --budget <s>       seconds to wait for the page to settle (default 6)',
    '  --settle <s>       extra seconds after it settles, before the rules run (default 3)',
    '  --no-contract      skip the design-contract engine',
    '  --attach <port>    scan inside a browser you already opened with a DevTools port',
    '                     on this machine, instead of launching a headless one (README)',
    '  --json             print the full report as JSON instead of the summary',
    '',
    'Exit codes: 0 no automated violations, 1 violations found,',
    '2 a WCAG number was withheld (the report says why), 3 the run could not start.',
    'Read METHOD.md before trusting a number this prints.',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Engine integrity: refuse to report numbers from an engine we cannot name
// ---------------------------------------------------------------------------

async function loadEngine() {
  const buf = await readFile(join(HERE, AXE.file));
  const exact = sha256(buf);
  if (exact === AXE.sha256) return { source: buf.toString('utf8'), sha256: exact, match: 'exact' };
  // A git checkout on Windows can rewrite LF as CRLF. The engine is the same
  // program either way, so accept it, and say so in the report.
  const text = buf.toString('utf8');
  const normalised = sha256(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8'));
  if (normalised === AXE.sha256) {
    return { source: text, sha256: exact, match: 'identical after converting CRLF line endings to LF' };
  }
  return { source: null, sha256: exact, match: 'mismatch' };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

function browserCandidates() {
  const list = [];
  if (platform() === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      list.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      list.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      list.push(join(root, 'Chromium', 'Application', 'chrome.exe'));
      list.push(join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    }
  } else if (platform() === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser']) {
      list.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
    }
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
                   'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
    for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
      for (const n of names) list.push(join(dir, n));
    }
  }
  return list;
}

function findBrowser(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) fail(`browser not found at ${explicit}`);
    return explicit;
  }
  const hit = browserCandidates().find((p) => existsSync(p));
  if (!hit) fail('no Chrome, Edge, Chromium or Brave found. Pass --browser <path> or set CHROME_PATH.');
  return hit;
}

async function launchBrowser(path) {
  const profile = await mkdtemp(join(tmpdir(), 'a11y-kit-'));
  const child = spawn(path, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--mute-audio',
    'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const [port, path2] = (await readFile(portFile, 'utf8')).split(/\r?\n/);
      if (port && path2) return { child, profile, wsUrl: `ws://127.0.0.1:${port}${path2}` };
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  child.kill();
  fail(`the browser at ${path} did not open a DevTools endpoint`);
}

// Attach to a browser the user already opened with --remote-debugging-port.
// Loopback only: a DevTools port on another machine is not the user's session.
async function attachBrowser(spec) {
  const m = /^(?:(127\.0\.0\.1|localhost|\[::1\]):)?(\d{2,5})$/.exec(String(spec).trim());
  if (!m) fail('--attach takes a port on this machine, for example --attach 9222');
  const host = m[1] || '127.0.0.1';
  const res = await fetch(`http://${host}:${m[2]}/json/version`).catch(() => null);
  if (!res || !res.ok) fail(`no DevTools endpoint answered on ${host}:${m[2]}`);
  const info = await res.json();
  return { child: null, profile: null, wsUrl: info.webSocketDebuggerUrl, attached: `${host}:${m[2]}` };
}

async function closeBrowser(b) {
  if (!b || !b.child) return;
  try { b.child.kill(); } catch { /* already gone */ }
  for (let i = 0; i < 20 && b.child.exitCode === null; i++) await sleep(100);
  // The profile is a throwaway; removal can race the browser's own shutdown.
  await rm(b.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// A minimal DevTools Protocol client over the built-in WebSocket
// ---------------------------------------------------------------------------

class Devtools {
  static open(url) {
    return new Promise((ok, no) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => ok(new Devtools(ws)), { once: true });
      ws.addEventListener('error', () => no(new Error('could not connect to the browser')), { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { ok, no, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) no(new Error(`${msg.error.message}`));
        else ok(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 60000) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((ok, no) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        no(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { ok, no, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function evaluate(dt, session, expression) {
  const r = await dt.send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, session, 120000);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'script error');
  }
  return r.result ? r.result.value : undefined;
}

// ---------------------------------------------------------------------------
// One viewport, one fresh tab
// ---------------------------------------------------------------------------

// A refusal page is read as text and quoted. It is never allowed to run: some
// are browser checks whose scripts would clear the way for the next request.
function refusalText(body, base64) {
  const html = base64 ? Buffer.from(body, 'base64').toString('utf8') : body;
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  const text = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: title.replace(/\s+/g, ' ').trim().slice(0, 120), text: text.slice(0, 200) };
}

async function scanViewport(dt, url, vp, engine, opts) {
  const out = { label: vp.label, width: vp.width, height: vp.height };
  // A launched browser gets a fresh cookie jar per width, so nothing the first
  // page set can change what the second one is served. An attached browser is
  // used as the person left it: that session is the point of attaching.
  const context = opts.attach ? null : (await dt.send('Target.createBrowserContext', {})).browserContextId;
  const created = await dt.send('Target.createTarget',
    context ? { url: 'about:blank', browserContextId: context } : { url: 'about:blank' });
  const { targetId } = created;
  const { sessionId: s } = await dt.send('Target.attachToTarget', { targetId, flatten: true });
  const events = { load: false, exceptions: 0, document: null, frameId: null, refusal: null };
  const off = dt.on((m) => {
    if (m.sessionId !== s) return;
    if (m.method === 'Page.loadEventFired') events.load = true;
    if (m.method === 'Runtime.exceptionThrown') events.exceptions += 1;
    if (m.method === 'Network.responseReceived' && m.params.type === 'Document' &&
        !events.document && (!events.frameId || m.params.frameId === events.frameId)) {
      events.document = { status: m.params.response.status, url: m.params.response.url };
    }
    // Every document response is paused here before the browser renders it.
    // A refusal of the top-level page is quoted and cancelled, so it never runs.
    if (m.method === 'Fetch.requestPaused') {
      const p = m.params;
      const topLevel = p.frameId === targetId;
      if (topLevel && p.responseStatusCode >= 400) {
        events.refusal = { status: p.responseStatusCode, url: p.request.url, page: null };
        dt.send('Fetch.getResponseBody', { requestId: p.requestId }, s)
          .then((b) => { events.refusal.page = refusalText(b.body, b.base64Encoded); })
          .catch(() => {})
          .finally(() => dt.send('Fetch.failRequest',
            { requestId: p.requestId, errorReason: 'BlockedByClient' }, s).catch(() => {}));
      } else {
        dt.send('Fetch.continueResponse', { requestId: p.requestId }, s)
          .catch(() => dt.send('Fetch.continueRequest', { requestId: p.requestId }, s).catch(() => {}));
      }
    }
  });
  try {
    await dt.send('Page.enable', {}, s);
    await dt.send('Runtime.enable', {}, s);
    await dt.send('Network.enable', {}, s);
    await dt.send('Fetch.enable',
      { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }, s);
    await dt.send('Emulation.setDeviceMetricsOverride',
      { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false }, s);

    const nav = await dt.send('Page.navigate', { url }, s);
    events.frameId = nav.frameId;
    if (events.refusal || nav.errorText === 'net::ERR_BLOCKED_BY_CLIENT') {
      for (let i = 0; i < 20 && events.refusal && !events.refusal.page; i++) await sleep(50);
      const status = events.refusal ? events.refusal.status : 'unknown';
      out.status = 'withheld';
      out.refused = true;
      out.http = { status, url: events.refusal ? events.refusal.url : url };
      out.refusal_page = events.refusal ? events.refusal.page : null;
      const turnedAway = [401, 403, 429, 503].includes(status);
      out.withheld_reason = (turnedAway ? `the server refused this browser (HTTP ${status})`
        : `the page answered HTTP ${status}`) +
        '. Its response was quoted and never run, and the kit does not retry';
      return out;
    }
    if (nav.errorText) {
      out.status = 'withheld';
      out.withheld_reason = `the page did not load (${nav.errorText})`;
      return out;
    }
    const loadDeadline = Date.now() + 30000;
    while (!events.load && Date.now() < loadDeadline) await sleep(100);
    out.load_event = events.load;

    // Readiness: poll until the DOM is worth auditing, within the budget.
    const budgetEnd = Date.now() + opts.budget * 1000;
    let ready = { readyState: 'unknown', bodyElements: 0, settled: false };
    do {
      const st = await evaluate(dt, s, READY_JS).catch(() => ({}));
      ready = {
        readyState: st.readyState || 'unknown',
        bodyElements: st.bodyElements || 0,
        settled: ['interactive', 'complete'].includes(st.readyState) && (st.bodyElements || 0) > 0,
      };
      if (ready.settled) break;
      await sleep(250);
    } while (Date.now() < budgetEnd);
    out.readiness = ready;
    out.http = events.document;

    // Belt and braces: the pause above should have caught any refusal.
    if (events.document && events.document.status >= 400) {
      out.status = 'withheld';
      out.refused = true;
      out.withheld_reason = `the server refused this browser (HTTP ${events.document.status})`;
      return out;
    }
    if (!ready.settled) {
      out.status = 'withheld';
      out.withheld_reason = `the page did not reach an auditable state within ${opts.budget} s ` +
        `(readyState ${ready.readyState}, ${ready.bodyElements} elements)`;
      return out;
    }
    await sleep(opts.settle * 1000);

    const motionDefault = await evaluate(dt, s, MOTION_JS).catch((e) => ({ err: String(e) }));
    const measured = await evaluate(dt, s, MEASURE_JS).catch((e) => ({ err: String(e) }));

    // `void 0` keeps the injection from trying to serialise the engine object.
    await evaluate(dt, s, `${engine.source}\n;void 0`);
    const r = await evaluate(dt, s, RUN_JS);
    if (!r || r.err) {
      out.status = 'withheld';
      out.withheld_reason = `the rules engine did not return results (${r ? r.err : 'no result'})`;
      return out;
    }
    const reported = r.engine && r.engine.version;
    if (reported !== AXE.version) {
      out.status = 'withheld';
      out.withheld_reason = `the engine reported version ${reported}, expected ${AXE.version}`;
      return out;
    }

    await dt.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, s);
    await sleep(500);
    const motionReduced = await evaluate(dt, s, MOTION_JS).catch((e) => ({ err: String(e) }));

    Object.assign(out, {
      status: 'reported',
      final_url: r.url,
      violations: r.violations,
      applicable_rules: r.passes + r.violations + r.incomplete,
      passes: r.passes,
      needs_review: r.incomplete,
      inapplicable: r.inapplicable,
      by_impact: r.byImpact,
      violation_detail: r.detail,
      needs_review_detail: r.needsReview,
      rule_ids: r.ruleIds,
      page_exceptions: events.exceptions,
      measured,
      motion: { as_loaded: motionDefault, reduced_motion_requested: motionReduced },
    });
    return out;
  } finally {
    off();
    await dt.send('Target.closeTarget', { targetId }).catch(() => {});
    if (context) await dt.send('Target.disposeBrowserContext', { browserContextId: context }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Local files: serve the folder on 127.0.0.1 for the length of the run
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
};

function serveFolder(root) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const full = resolve(base, `.${path}`);
      if (full !== base && !full.startsWith(base + sep)) { res.writeHead(403).end(); return; }
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function resolveTarget(raw) {
  if (/^https?:\/\//i.test(raw)) return { url: new URL(raw).href, served: null };
  if (/^file:\/\//i.test(raw)) return { url: new URL(raw).href, served: null };
  const full = resolve(raw);
  const info = await stat(full).catch(() => null);
  if (!info) fail(`${raw} is neither an http(s) URL nor a file on this machine`);
  const file = info.isDirectory() ? join(full, 'index.html') : full;
  if (!existsSync(file)) fail(`no index.html in ${raw}`);
  const server = await serveFolder(dirname(file));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/${encodeURIComponent(basename(file))}`, served: { server, file } };
}

// ---------------------------------------------------------------------------
// The design-contract engine, run as its own process
// ---------------------------------------------------------------------------

function npxCommand() {
  // Spawning npx.cmd on Windows needs a shell, and a URL in a shell command
  // line is an injection risk. npm ships npx as a script next to node; use it.
  const candidates = [
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    resolve(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  const cli = candidates.find((p) => existsSync(p));
  if (cli) return { cmd: execPath, pre: [cli] };
  if (platform() !== 'win32') return { cmd: 'npx', pre: [] };
  return null;
}

function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

// The CLI prints a status line before its JSON and another after it, so parse
// the first complete JSON object rather than the whole stream.
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* keep shrinking */ }
  }
  return null;
}

function runContract(url) {
  const spec = `${CONTRACT.pkg}@${CONTRACT.version}`;
  const command = `npx --yes ${spec} ${url} --scope ${CONTRACT.scope} --json`;
  const npx = npxCommand();
  if (!npx) {
    return Promise.resolve({ status: 'withheld', command, withheld_reason: 'npx could not be located without a shell' });
  }
  return new Promise((ok) => {
    const child = spawn(npx.cmd, [...npx.pre, '--yes', spec, url, '--scope', CONTRACT.scope, '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    let se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    const timer = setTimeout(() => child.kill(), 180000);
    child.on('error', (e) => {
      clearTimeout(timer);
      ok({ status: 'withheld', command, withheld_reason: `the contract engine could not start (${e.message})` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const clean = stripAnsi(so);
      const j = firstJsonObject(clean);
      if (!j || j.ok === false || typeof j.score !== 'number') {
        const said = stripAnsi(`${se}\n${so}`).trim().split('\n').filter(Boolean).slice(-3).join(' | ');
        ok({ status: 'withheld', command, exit_code: code, raw: clean,
             withheld_reason: `the contract engine returned no score (exit ${code}${said ? `: ${said}` : ''})` });
        return;
      }
      ok({ status: 'reported', command, exit_code: code, raw: clean, result: j });
    });
  });
}

// ---------------------------------------------------------------------------
// Settling engine flags against the measurements
// ---------------------------------------------------------------------------

function ruleStatus(vp, id) {
  if (vp.status !== 'reported') return 'not run';
  const ids = vp.rule_ids;
  if (ids.violations.includes(id)) return 'violation';
  if (ids.incomplete.includes(id)) return 'needs review';
  if (ids.passes.includes(id)) return 'pass';
  if (ids.inapplicable.includes(id)) return 'nothing to test';
  return 'not run';
}

function settleChecks(contract, viewports) {
  const reported = viewports.filter((v) => v.status === 'reported' && v.measured && !v.measured.err);
  const byId = new Map((contract.result ? contract.result.checks : []).map((c) => [c.id, c]));
  const settle = [];
  const add = (id, measuredVerdict, evidence) => {
    const c = byId.get(id);
    const engine = c ? c.status : 'absent';
    let disposition;
    if (!c) disposition = 'engine did not run this check';
    else if (engine === 'PASS') {
      disposition = measuredVerdict === 'fail' ? 'engine passed it; measurement disagrees'
        : measuredVerdict === 'unsettled' ? 'engine passed it; measurement could not confirm'
        : measuredVerdict === 'not applicable' ? 'agrees: nothing to test on this page' : 'agrees';
    } else if (engine === 'WARN' || engine === 'FAIL') {
      disposition = measuredVerdict === 'fail' ? 'confirmed'
        : measuredVerdict === 'pass' ? 'rejected on re-measurement'
        : measuredVerdict === 'not applicable' ? 'rejected: not applicable to this page'
        : 'not settled: left for a person';
    } else {
      disposition = `engine status ${engine}`;
    }
    settle.push({ id, item: c ? c.item : null, engine_status: engine, engine_detail: c ? c.detail : null,
                  measured: measuredVerdict, disposition, evidence });
  };

  if (reported.length === 0) return { settled: settle, note: 'no viewport was measured, so no flag was settled' };

  // v24: target size. The verdict is axe-core's target-size rule, which
  // implements 2.5.8 including its spacing and inline exceptions. The box
  // counts are context: a small target with room around it still passes AA.
  {
    const per = reported.map((v) => ({
      width: v.width,
      axe_target_size: ruleStatus(v, 'target-size'),
      boxes_under_24_before_spacing_exception: v.measured.targets_below_24.length,
      boxes_under_44_aaa_advice: v.measured.targets_below_44.length,
    }));
    let verdict;
    if (per.some((p) => p.axe_target_size === 'violation')) verdict = 'fail';
    else if (per.every((p) => ['pass', 'nothing to test'].includes(p.axe_target_size))) verdict = 'pass';
    else if (per.every((p) => p.axe_target_size === 'not run' && p.boxes_under_24_before_spacing_exception === 0)) verdict = 'pass';
    else verdict = 'unsettled';
    add('v24', verdict, per);
  }
  // v34: an AI chat interface needs somewhere to type, or an embedded frame.
  {
    const per = reported.map((v) => ({ width: v.width, text_entry: v.measured.textEntry, frames: v.measured.frames }));
    const none = per.every((p) => p.text_entry === 0 && p.frames === 0);
    add('v34', none ? 'not applicable' : 'unsettled', per);
  }
  // v27: iOS zooms into inputs under 16 px.
  {
    const inputs = reported[0].measured.inputs;
    const verdict = inputs.length === 0 ? 'not applicable'
      : inputs.every((i) => (i.fontSizePx || 0) >= 16) ? 'pass' : 'fail';
    add('v27', verdict, { inputs: inputs.length, under_16px: inputs.filter((i) => (i.fontSizePx || 0) < 16).length });
  }
  // v28: characters per line, measured on the desktop width.
  {
    const desk = reported.find((v) => v.label === 'desktop') || reported[0];
    const over = desk.measured.proseOver75;
    add('v28', desk.measured.paragraphs === 0 ? 'not applicable' : over.length === 0 ? 'pass' : 'fail',
      { width: desk.width, paragraphs: desk.measured.paragraphs, over_75: over.length,
        longest: Math.max(0, ...desk.measured.proseOver75.map((p) => p.lineCh)) || null });
  }
  // v05: with reduced motion requested, is anything still animating?
  {
    const per = reported.map((v) => {
      const m = v.motion.reduced_motion_requested || {};
      const d = v.motion.as_loaded || {};
      return { width: v.width, running_as_loaded: d.running, running_with_reduce: m.running,
               infinite_with_reduce: m.infinite, smooth_scroll_with_reduce: m.scrollBehavior === 'smooth',
               media_query_took_effect: m.reduceMatches === true };
    });
    let verdict;
    if (per.some((p) => !p.media_query_took_effect || p.running_with_reduce === undefined)) verdict = 'unsettled';
    else if (per.every((p) => p.running_with_reduce === 0 && !p.smooth_scroll_with_reduce)) verdict = 'pass';
    else if (per.some((p) => p.infinite_with_reduce > 0)) verdict = 'fail';
    else verdict = 'unsettled';
    add('v05', verdict, per);
  }
  return { settled: settle };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function contractSummary(contract, settled) {
  if (contract.status !== 'reported') {
    return { status: contract.status, command: contract.command, score: null, grade: null,
             withheld_reason: contract.withheld_reason || null };
  }
  const j = contract.result;
  const flags = j.checks.filter((c) => c.status === 'WARN' || c.status === 'FAIL');
  const settledIds = new Set(settled.settled.map((s) => s.id));
  const dispositions = flags.map((c) => (settled.settled.find((s) => s.id === c.id) || {}).disposition || '');
  const outcomes = {
    confirmed: dispositions.filter((d) => d === 'confirmed').length,
    rejected: dispositions.filter((d) => d.startsWith('rejected')).length,
    not_settled: dispositions.filter((d) => d.startsWith('not settled')).length,
    not_re_measured: dispositions.filter((d) => d === '').length,
  };
  return {
    status: 'reported',
    command: contract.command,
    engine: `${CONTRACT.pkg} ${CONTRACT.version}`,
    contract_version: j.contractVersion,
    scope: j.scope,
    score: j.score,
    grade: j.grade,
    checks_total: j.total,
    checks_scored: j.scored,
    counts: { pass: j.pass, warn: j.warn, fail: j.fail, skip: j.skip, not_measured_by_engine: j.manual },
    flags_raised: flags.length,
    flag_outcomes: outcomes,
    flags: flags.map((c) => ({
      id: c.id, category: c.category, status: c.status, item: c.item, detail: c.detail,
      settled_by_measurement: settledIds.has(c.id),
      disposition: (settled.settled.find((s) => s.id === c.id) || {}).disposition || 'not re-measured: reported as the engine raised it',
    })),
    engine_did_not_measure: j.checks.filter((c) => c.status === 'MANUAL').map((c) => ({ id: c.id, item: c.item })),
    cross_checks: settled.settled,
  };
}

// Widths are reported separately. The same rule failing at both widths is one
// problem seen twice, so the headline is the worst width, never a sum.
function headline(viewports) {
  const withheld = viewports.filter((v) => v.status !== 'reported');
  if (withheld.length) {
    return { violations_at_worst_width: null, provenance: 'observed',
             withheld_reason: withheld.map((v) => `${v.width} px: ${v.withheld_reason}`).join('; ') };
  }
  return {
    violations_at_worst_width: Math.max(...viewports.map((v) => v.violations)),
    per_width: viewports.map((v) => ({ width: v.width, violations: v.violations,
                                       applicable_rules: v.applicable_rules, needs_review: v.needs_review })),
    provenance: 'observed',
  };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function summaryText(report) {
  const L = [];
  const t = report.target;
  L.push(`Accessibility verification kit ${KIT.version}`);
  L.push(`Target      ${t.url}${t.http_status ? `  (HTTP ${t.http_status})` : ''}`);
  if (t.served_from_file) L.push(`            served from a local file for this run`);
  L.push(`Run         ${report.ran_at}`);
  L.push(`Engine      axe-core ${AXE.version}  sha256 ${report.engines.axe.sha256.slice(0, 12)}...  ${report.engines.axe.match}`);
  L.push('');
  L.push('WCAG 2.2 AA, automated rules');
  for (const v of report.wcag.viewports) {
    if (v.status === 'reported') {
      L.push(`  ${pad(`${v.width} px`, 9)} ${v.violations} violations / ${v.applicable_rules} applicable rules` +
        `   needs review ${v.needs_review}   exceptions on page ${v.page_exceptions}`);
      for (const d of v.violation_detail) L.push(`            [${d.impact}] ${d.id} x${d.nodes}  ${d.help}`);
      for (const d of v.needs_review_detail) L.push(`            needs review: ${d.id} x${d.nodes}  ${d.help}`);
    } else {
      L.push(`  ${pad(`${v.width} px`, 9)} null   ${v.withheld_reason}`);
      if (v.refusal_page) {
        L.push(`            refusal page: "${v.refusal_page.title}"  ${v.refusal_page.text.slice(0, 100)}`);
      }
    }
  }
  const m = report.wcag.viewports.filter((v) => v.status === 'reported' && v.measured && !v.measured.err);
  if (m.length) {
    const row = (label, f) => L.push(`  ${pad(label, 50)} ${m.map((v) => `${v.width}: ${f(v)}`).join('   ')}`);
    L.push('');
    L.push('Re-measured in the rendered page');
    row('target-size rule (WCAG 2.5.8, AA)', (v) => ruleStatus(v, 'target-size'));
    row('  boxes under 24 px, before spacing exception', (v) => v.measured.targets_below_24.length);
    row('  boxes under 44 px (AAA, advice only)', (v) => v.measured.targets_below_44.length);
    row('text entry fields', (v) => v.measured.textEntry);
    row('paragraphs over 75 characters per line', (v) => v.measured.proseOver75.length);
    row('sideways scroll (px)', (v) => v.measured.overflowX);
    row('animations running, as loaded', (v) => (v.motion.as_loaded || {}).running ?? 'n/a');
    row('animations running, reduced motion requested', (v) => (v.motion.reduced_motion_requested || {}).running ?? 'n/a');
  }
  L.push('');
  const c = report.contract;
  if (c.status === 'reported') {
    L.push(`Design contract (${c.engine}, scope ${c.scope})`);
    L.push(`  engine score   ${c.score} (${c.grade})   ${c.checks_scored} of ${c.checks_total} checks scored` +
      `   ${c.counts.pass} pass, ${c.counts.warn} warn, ${c.counts.fail} fail, ${c.counts.skip} skipped,` +
      ` ${c.counts.not_measured_by_engine} not measured by the engine`);
    L.push(`  flags raised   ${c.flags_raised}`);
    for (const f of c.flags) L.push(`    ${pad(f.id, 5)} ${pad(f.status, 5)} ${pad((f.item || '').slice(0, 44), 45)} ${f.disposition}`);
    const passes = c.cross_checks.filter((x) => x.engine_status === 'PASS');
    if (passes.length) {
      L.push('  engine passes, cross-checked');
      for (const x of passes) L.push(`    ${pad(x.id, 5)} PASS  ${pad((x.item || '').slice(0, 44), 45)} ${x.disposition}`);
    }
  } else if (c.status === 'skipped') {
    L.push('Design contract   skipped (--no-contract)');
  } else {
    L.push(`Design contract   null   ${c.withheld_reason}`);
  }
  L.push('');
  L.push(`Misfire rate      null   ${report.misfire_rate.reason}`);
  L.push('');
  L.push('Not measured by this kit:');
  for (const n of NOT_MEASURED) L.push(`  - ${n}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const major = Number((versions.node || '0').split('.')[0]);
  if (major < 22 || typeof WebSocket === 'undefined') fail(`Node 22 or newer is required (this is ${versions.node})`);
  const opts = parseArgs(argv.slice(2));

  const engine = await loadEngine();
  const ranAt = isoLocal();
  const target = await resolveTarget(opts.target);
  const browserPath = opts.attach ? null : findBrowser(opts.browser);
  const outDir = resolve(opts.out, `${slugFor(target.url)}-${stampFor()}`);

  // The report names the exact runner that wrote it. Hashed with LF line
  // endings so a Windows checkout reports the same hash as any other.
  const runnerText = (await readFile(fileURLToPath(import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

  const report = {
    kit: { ...KIT, runner_sha256_lf: sha256(Buffer.from(runnerText, 'utf8')) },
    ran_at: ranAt,
    command: ['node', 'verify.mjs', ...argv.slice(2)].join(' '),
    target: { requested: opts.target, url: target.url, served_from_file: target.served ? basename(target.served.file) : null },
    engines: {
      axe: { version: AXE.version, sha256: engine.sha256, pinned_sha256: AXE.sha256, match: engine.match, tags: AXE.tags },
      contract: opts.contract ? { package: CONTRACT.pkg, version: CONTRACT.version, scope: CONTRACT.scope } : null,
    },
    parameters: { viewports: VIEWPORTS, readiness_budget_s: opts.budget, settle_s: opts.settle,
                  browser: opts.attach
                    ? 'attached to a browser session the person opened; its cookies and sign-ins apply'
                    : 'headless, fresh profile, separate cookie jar per width, no extensions' },
    environment: { node: versions.node, os: `${platform()} ${arch()}`, browser: null },
  };

  let browser = null;
  let dt = null;
  try {
    let viewports;
    if (!engine.source) {
      const reason = `engine file does not match the pinned hash (found ${engine.sha256}, pinned ${AXE.sha256})`;
      viewports = VIEWPORTS.map((vp) => ({ ...vp, status: 'withheld', withheld_reason: reason }));
    } else {
      browser = opts.attach ? await attachBrowser(opts.attach) : await launchBrowser(browserPath);
      dt = await Devtools.open(browser.wsUrl);
      const ver = await dt.send('Browser.getVersion');
      report.environment.browser = ver.product;
      viewports = [];
      for (const vp of VIEWPORTS) {
        // After a refusal, stop. A later request in the same session could be
        // served differently because of the refusal, and that is not the page.
        if (viewports.some((v) => v.refused)) {
          viewports.push({ ...vp, status: 'withheld',
                           withheld_reason: 'not attempted: the server refused the first request' });
          continue;
        }
        viewports.push(await scanViewport(dt, target.url, vp, engine, opts).catch((e) => ({
          ...vp, status: 'withheld', withheld_reason: `the scan failed (${e.message})`,
        })));
      }
    }
    const first = viewports.find((v) => v.http);
    report.target.http_status = first ? first.http.status : null;
    report.target.final_url = (viewports.find((v) => v.final_url) || {}).final_url || null;
    report.wcag = { headline: headline(viewports), viewports };

    let contract = { status: 'skipped', command: null };
    if (opts.contract) contract = await runContract(target.url);
    const settled = settleChecks(contract, viewports);
    report.contract = contract.status === 'skipped'
      ? { status: 'skipped', score: null, grade: null, withheld_reason: 'skipped with --no-contract' }
      : contractSummary(contract, settled);

    report.misfire_rate = {
      value: null,
      provenance: null,
      reason: 'a URL has no input method of its own; for entries that ship one, measure it with access-conformance (METHOD.md 1.4)',
    };
    report.not_measured = NOT_MEASURED;

    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (contract.raw) await writeFile(join(outDir, 'contract-engine-output.txt'), contract.raw);
    const text = summaryText(report);
    await writeFile(join(outDir, 'summary.txt'), text + '\n');

    if (opts.json) stdout.write(JSON.stringify(report, null, 2) + '\n');
    else console.log(`${text}\n\nReport: ${join(outDir, 'report.json')}`);

    const worst = report.wcag.headline.violations_at_worst_width;
    if (worst === null) return 2;
    return worst > 0 ? 1 : 0;
  } finally {
    if (dt) dt.close();
    await closeBrowser(browser);
    if (target.served) target.served.server.close();
  }
}

main().then((code) => exit(code), (e) => fail(e && e.stack ? e.stack : String(e)));
