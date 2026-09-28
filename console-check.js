// Check a page by hand, with the same engine and rules as the kit.
//
// Open the page in your own browser, open the developer console, paste this
// whole file and press Enter. It loads axe-core 4.13.0 from jsDelivr with an
// integrity hash, so the browser refuses to run any other file, then prints
// violations over applicable rules for the width you are viewing. Narrow the
// window (or use the device toolbar) to 320 px to repeat the reflow width.
//
// If the page's security policy blocks scripts from jsDelivr, paste the
// contents of engine/axe.min.js into the console first, then this file.
(async () => {
  const ENGINE = 'https://cdn.jsdelivr.net/npm/axe-core@4.13.0/axe.min.js';
  const INTEGRITY = 'sha256-wk8Je9L0UdT5M+i8fY1Tn4ZyouvLXMn58+7IypRwoME=';
  const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

  if (!window.axe) {
    await new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = ENGINE;
      s.integrity = INTEGRITY;
      s.crossOrigin = 'anonymous';
      s.onload = ok;
      s.onerror = () => no(new Error('the engine was blocked or failed its integrity check'));
      document.head.appendChild(s);
    });
  }
  if (axe.version !== '4.13.0') {
    console.warn(`this page already had axe-core ${axe.version} loaded; results are from that version`);
  }
  const r = await axe.run(document, { runOnly: { type: 'tag', values: TAGS } });
  const applicable = r.passes.length + r.violations.length + r.incomplete.length;
  console.log(
    `axe-core ${r.testEngine.version} at ${innerWidth} px: ` +
    `${r.violations.length} violations / ${applicable} applicable rules, ` +
    `${r.incomplete.length} left for a person to review`
  );
  if (r.violations.length) {
    console.table(r.violations.map((v) => ({ rule: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })));
  }
  if (r.incomplete.length) {
    console.table(r.incomplete.map((v) => ({ review: v.id, nodes: v.nodes.length, help: v.help })));
  }
  return { width: innerWidth, violations: r.violations.length, applicable, needsReview: r.incomplete.length };
})();
