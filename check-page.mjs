#!/usr/bin/env node
/**
 * Confirms that index.html, RECEIPTS.json and the raw outputs agree.
 *
 *   node check-page.mjs            check, exit 0 when everything agrees, 1 otherwise
 *   node check-page.mjs --render   rewrite the two receipts tables in index.html
 *                                  from RECEIPTS.json, then check
 *
 * For every figure on the page (a <data data-receipt="Rn"> element) it checks
 * that the receipt exists, that the text shown is the receipt's display value,
 * and that the receipt's value is what the cited raw output holds at the cited
 * JSON pointer. For every run it checks that the raw output exists and, where
 * the output records one, that its command and time match the receipt.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, 'index.html');
const RECEIPTS = join(HERE, 'RECEIPTS.json');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const shown = (f) => (f.display !== undefined ? f.display : String(f.value));

function deref(doc, pointer) {
  if (pointer === '') return doc;
  return pointer.split('/').slice(1)
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), doc);
}

function renderTables(html, receipts) {
  const runs = receipts.runs.map((r) => [
    `      <li id="run-${esc(r.id.toLowerCase())}">`,
    `        <h4>Run ${esc(r.id)}: ${esc(r.label)}</h4>`,
    '        <dl>',
    `          <dt>Command</dt><dd><code>${esc(r.command)}</code></dd>`,
    `          <dt>Ran at</dt><dd>${esc(r.ran_at)}${r.ran_at_evidence ? ` (${esc(r.ran_at_evidence)})` : ''}</dd>`,
    `          <dt>Raw output</dt><dd><a href="${esc(r.file)}">${esc(r.file)}</a></dd>`,
    ...(r.note ? [`          <dt>Note</dt><dd>${esc(r.note)}</dd>`] : []),
    '        </dl>',
    '      </li>',
  ].join('\n')).join('\n');
  const figures = receipts.figures.map((f) => [
    `      <div class="receipt" id="${esc(f.id.toLowerCase())}">`,
    `        <dt><span class="rid">${esc(f.id)}</span> <span class="what">${esc(f.figure)}</span></dt>`,
    `        <dd class="val"><data value="${esc(String(f.value))}" data-receipt="${esc(f.id)}">${esc(shown(f))}</data></dd>`,
    `        <dd class="src">run <a href="#run-${esc(f.run.toLowerCase())}">${esc(f.run)}</a>, <code>${esc(f.pointer)}</code></dd>`,
    '      </div>',
  ].join('\n')).join('\n');
  const swap = (text, name, body) => {
    const re = new RegExp(`<!-- ${name}:BEGIN -->[\\s\\S]*?<!-- ${name}:END -->|<!-- ${name} -->`);
    if (!re.test(text)) throw new Error(`no ${name} marker in index.html`);
    return text.replace(re, () => `<!-- ${name}:BEGIN -->\n${body}\n      <!-- ${name}:END -->`);
  };
  return swap(swap(html, 'RUNS', runs), 'FIGURES', figures);
}

async function main() {
  const receipts = JSON.parse(await readFile(RECEIPTS, 'utf8'));
  let html = await readFile(PAGE, 'utf8');
  if (argv.includes('--render')) {
    html = renderTables(html, receipts);
    await writeFile(PAGE, html);
    console.log('rendered the receipts tables from RECEIPTS.json');
  }

  const problems = [];
  const runs = new Map();
  for (const r of receipts.runs) {
    const path = join(HERE, r.file);
    if (!existsSync(path)) { problems.push(`run ${r.id}: raw output ${r.file} is missing`); continue; }
    const doc = JSON.parse(await readFile(path, 'utf8'));
    runs.set(r.id, doc);
    if (doc.ran_at !== undefined && doc.ran_at !== r.ran_at) {
      problems.push(`run ${r.id}: receipt says ${r.ran_at}, raw output says ${doc.ran_at}`);
    }
    if (doc.command !== undefined && doc.command !== r.command) {
      problems.push(`run ${r.id}: receipt command "${r.command}", raw output "${doc.command}"`);
    }
  }

  const figures = new Map();
  for (const f of receipts.figures) {
    if (figures.has(f.id)) problems.push(`${f.id} is listed twice`);
    figures.set(f.id, f);
    const doc = runs.get(f.run);
    if (!doc) { problems.push(`${f.id}: cites run ${f.run}, which has no raw output`); continue; }
    const actual = deref(doc, f.pointer);
    if (actual === undefined) problems.push(`${f.id}: nothing at ${f.pointer} in run ${f.run}`);
    else if (actual !== f.value) {
      problems.push(`${f.id}: receipt value ${JSON.stringify(f.value)}, raw output ${JSON.stringify(actual)}`);
    }
  }

  const seen = new Map();
  const dataRe = /<data\b([^>]*)>([\s\S]*?)<\/data>/g;
  for (const m of html.matchAll(dataRe)) {
    const attrs = m[1];
    const id = (/\bdata-receipt="([^"]+)"/.exec(attrs) || [])[1];
    if (!id) continue;
    const value = unesc((/\bvalue="([^"]*)"/.exec(attrs) || [])[1] ?? '');
    const text = unesc(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    seen.set(id, (seen.get(id) || 0) + 1);
    const f = figures.get(id);
    if (!f) { problems.push(`page shows ${id}, which has no receipt`); continue; }
    if (value !== String(f.value)) problems.push(`page ${id}: value attribute "${value}", receipt ${JSON.stringify(f.value)}`);
    if (text !== shown(f)) problems.push(`page ${id}: shows "${text}", receipt display "${shown(f)}"`);
  }
  for (const id of figures.keys()) {
    if (!seen.has(id)) problems.push(`${id} is in RECEIPTS.json but not on the page`);
  }
  for (const m of html.matchAll(/href="#(r\d+)"/g)) {
    if (!new RegExp(`\\sid="${m[1]}"`).test(html)) problems.push(`link to #${m[1]} has no target on the page`);
  }

  const occurrences = [...seen.values()].reduce((a, b) => a + b, 0);
  if (problems.length) {
    console.log(`FAIL: ${problems.length} problem(s)`);
    for (const p of problems) console.log(`  - ${p}`);
    return 1;
  }
  console.log(`CLEAN: ${figures.size} figures, ${occurrences} places on the page, ${runs.size} runs; ` +
    'every figure matches its receipt and every receipt matches its raw output');
  return 0;
}

main().then((code) => exit(code), (e) => { console.error(e.stack || String(e)); exit(1); });
