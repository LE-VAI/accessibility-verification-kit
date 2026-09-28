# Method

How this kit turns a URL into numbers, what those numbers mean, and what they
cannot tell you. Written before the kit was built. The page and the runner
follow it rather than the other way round.

**The thesis:** most accessibility work ships without a number. A number beats
a claim, and only while its denominator and its method travel with it.

---

## 1. What the kit measures

One run takes one URL and produces four kinds of result.

### 1.1 Automated WCAG 2.2 Level AA rules

- **Engine:** axe-core 4.13.0, the open-source rules engine maintained by
  Deque. The kit ships the engine file and checks its SHA-256 before every run
  (section 6).
- **Rules:** every rule axe-core tags `wcag2a`, `wcag2aa`, `wcag21a`,
  `wcag21aa` or `wcag22aa`. Best-practice rules are excluded, because they are
  advice rather than WCAG criteria.
- **Where:** a real browser renders the page and axe-core runs against the live
  DOM, after scripts have run. Static HTML is a different page from the one a
  visitor sees.
- **At two widths:** 1280 CSS px (a desktop window) and 320 CSS px (the width
  WCAG 1.4.10 Reflow uses). A page can pass at one width and fail at the other,
  so each width is reported on its own line.

For each width the kit reports:

| Field | Meaning |
|---|---|
| `violations` | rules that failed on this page |
| `applicable_rules` | rules that found something to test (passes + violations + needs-review) |
| `needs_review` | rules axe-core could not decide, listed for a person to check; never counted as passes |
| `inapplicable` | rules with nothing to test here (a page with no video has no caption rule to run) |

A result is always printed as **violations over applicable rules**, for example
`0 / 21`. The denominator is the number of rules that actually had something to
test on this page. Two sites with `0` violations can have very different
denominators, so bare counts are not comparable across sites.

### 1.2 Re-measurement of rendered properties

Some questions are better answered by measuring the rendered page than by
reading its CSS. The kit measures, at each width:

- **Target sizes.** The rendered box of every link, button and form control,
  counted against 24 by 24 CSS px and against 44 px (2.5.5, Level AAA, reported
  as advice). These counts are context. The AA verdict (WCAG 2.5.8) comes from
  axe-core's `target-size` rule, which also applies the criterion's spacing
  exception: a small target with enough room around it passes.
- **Form inputs.** Whether the page has any `input`, `select`, `textarea` or
  editable region at all.
- **Prose measure.** Approximate characters per line for paragraphs, flagged
  above 75.
- **Horizontal overflow.** Whether the document scrolls sideways at that width.
- **Reduced motion.** The browser is told the visitor prefers reduced motion,
  and the kit counts the animations and transitions still running.

### 1.3 A design-contract score

The kit runs `designesy-score` 1.0.4 (40 checks across tokens, motion,
typography, accessibility and more) with `--scope universal`, which skips
features the contract treats as optional for sites outside its own system.
Every entry is scored in the same scope so scores are comparable.

This score is the engine's own number, reported as the engine reports it. The
kit does not adjust it. Section 3 explains what the kit does with its flags.

### 1.4 Misfire rate, for entries that ship an input method

A misfire rate belongs to an input method: dwell clicking, switch scanning,
gaze, EMG, anything that turns a body movement into an activation. It counts
activations the person did not intend, per hour the input was armed.

It is measured with `access-conformance`, a separate open-source instrument,
and only when the entry ships an input method. A website has no input method
of its own, so for a URL the kit prints the slot as `null` and says why.

### 1.5 Pages that refuse automated browsers

Some hosts put a browser check in front of their pages. A fresh automated
browser is served the check with an HTTP error instead of the page.

The kit reads the status of the page before the page is allowed to render. A
refusal is quoted in the report as text and never run, because some refusal
pages are browser checks whose scripts would clear the way for the next
request. The kit then stops, prints `null` for every width, and does not retry.

To scan such a page, open it yourself in a browser started with a DevTools
port, then run the kit with `--attach` (README). The kit opens a tab in that
session and scans the page you were served. The report records which mode
produced each number, because the two can differ: an attached session carries
its cookies and sign-ins.

---

## 2. The rules every number follows

1. **Provenance travels with the number.** Every figure says whether its
   denominator was `observed` in the run or `declared` by someone. This kit
   reports observed figures only.
2. **A number the kit cannot stand behind prints as `null`, with the reason.**
   A `0` would read as "nothing wrong". The truth in those cases is "nothing
   measured". The kit withholds a number when:
   - the engine file does not match its pinned hash;
   - the page answered with an HTTP error, or the server refused the browser
     (section 1.5);
   - the page never reached a state worth auditing (see section 5);
   - the contract engine refused the URL or failed;
   - a misfire rate has less than 15 minutes of observed exposure.
3. **Flags and findings are kept apart.** An engine raises flags. The kit
   re-measures what it can. A flag becomes a finding only after re-measurement
   confirms it; a flag the kit could not re-measure stays labelled as a flag.
4. **Needs-review is its own column.** Items axe-core cannot decide go to a
   person. They are never added to the passes.
5. **The report names what it did not look at** (section 4), in the report
   itself, every run.

---

## 3. Engine flags and how they are settled

Rules engines are fast and they are sometimes wrong. The kit's job is to say
which of their flags survive contact with the rendered page.

| Contract check | What the engine does | How the kit settles it |
|---|---|---|
| `v24` touch targets | Applies 44 px (the AAA figure) and labels it 2.5.8 (the AA criterion, whose figure is 24 px) | Settled by axe-core's `target-size` rule, which implements 2.5.8 with its spacing and inline exceptions: rejected when that rule passes or has nothing to test at every width, confirmed when it fails. Rendered box sizes are reported beside it as context |
| `v34` AI disclosure | Flags a page whose text mentions AI and carries no disclosure marker | Rejected as not applicable when the page has no text entry and no embedded frame, since a chat interface needs one. Otherwise left for a person |
| `v27` input font size | Looks for a font-size rule on inputs | Not applicable when the page has no inputs |
| `v28` reading measure | Looks for a `max-width` written in `ch` units | Settled by the rendered measure instead of the CSS unit |
| `v05` reduced motion | Checks that a `prefers-reduced-motion` query exists | Settled by counting animations still running with reduced motion requested |

Any other flag is reported as the engine raised it, marked **not re-measured**.
The kit does not guess.

This table exists because of a real case. On 2026-09-24 a 42-check
implementation of the same design contract raised four accessibility flags
against opethon.com. Re-measured in a live page, all four were wrong: a
reduced-motion check that penalised the better of the two correct patterns, an
input-size warning on a page with no inputs, a line-length claim on paragraphs
that measured 50 to 60 characters, and a target-size warning that used the AAA
figure against an AA rule.

Against the same page today, the published engine still raises the target-size
flag. The other three now pass, and each passes by finding or missing a CSS
pattern rather than by measuring the page. A check that reads the stylesheet
can pass for the wrong reason as easily as it can fail for one, so the kit
measures all of them on every run.

---

## 4. What automation cannot see

Automated rules cover a fraction of WCAG. W3C's position is that no tool alone
can determine whether a site meets accessibility standards. Everything below is
outside what this kit measures:

- **Whether people can use it.** Whether a screen reader user, a switch user or
  a person with low vision can finish the task the entry exists for. Only
  testing with people answers that.
- **Meaning.** Whether alt text describes the image, whether headings describe
  their sections, whether the reading order makes sense, whether error
  messages help.
- **Anything behind an interaction.** Menus opened, dialogs shown, forms
  submitted, states after sign-in. The kit loads one page and does not click.
- **Other pages.** One run covers one URL.
- **Keyboard use end to end.** Focus order, focus traps, visible focus across a
  whole task.
- **Speech output.** What assistive technology actually announces.
- **Cognitive load, captions quality, plain language.**
- **Speed.** Core Web Vitals need field data; one lab load is not a measurement
  of them.

That is why the offer is verification. The kit tells an entrant which automated
checks their page passes, with receipts, and it tells a judge exactly where
human testing has to take over.

---

## 5. Stated parameters

These values are engineering choices. They are stated so anyone can disagree
with them precisely.

| Parameter | Value | Why |
|---|---|---|
| Timing | load event (up to 30 s), then up to 6 s for the page to settle, then 3 s before the rules run | Enough for most pages to finish rendering; the result records whether the page settled |
| Settled means | `readyState` is `interactive` or `complete` and the body contains elements | A skeleton page reports `complete` with almost nothing in it |
| Widths | 1280 x 900 and 320 x 640 CSS px, each in a fresh tab | Desktop, and the WCAG 1.4.10 reflow width |
| Browser | Chromium-family, headless, fresh profile, a separate cookie jar for each width | No extensions, no stored sign-in, the page a first-time visitor sees |
| Refusals | an HTTP 4xx or 5xx on the page itself is quoted, never run; remaining widths are not attempted | A refusal page describes the host's policy, and scoring it would describe nothing |
| Attached session | `--attach` scans inside a browser the person opened | For pages a fresh browser cannot reach; the report says the session's cookies applied |
| Inline exception for box counts | a link displayed inline whose paragraph, list item or cell also holds other text | Mirrors the 2.5.8 exception for targets inside a line of text; a link alone in a list item is counted |
| Prose measure | rendered width divided by half the font size | An approximation of characters per line; flagged above 75 |
| Contract scope | `universal` | Same scope for every entry |
| Misfire exposure floor | 15 minutes observed | The instrument's own floor; below it the rate is `null` |

---

## 6. Check us instead of trusting us

- **The engine file.** `engine/axe.min.js` is axe-core 4.13.0, unmodified.
  Its SHA-256 is pinned in the runner, and the runner refuses to report if the
  file on disk differs. Compare it with the copy npm serves:
  `https://cdn.jsdelivr.net/npm/axe-core@4.13.0/axe.min.js`.
- **The rule set.** The tag list in section 1.1 is the whole selection. No rule
  is disabled.
- **An independent run.** Deque's own command-line tool runs the same engine
  version with the same tags. If its counts and ours differ on the same page,
  one of us is wrong, and we want to hear about it.
- **The receipts.** Every figure on the page is listed in `RECEIPTS.json` with
  the command that produced it and the time it ran. Run the command yourself
  and compare.

---

## 7. What a reader should conclude

**A result of `0 / 21` at both widths supports this sentence:** at the time of
the run, at those widths, the 21 automated WCAG 2.2 AA rules that applied to
this page found no violations, and nothing was left for review.

It does not support "this site is accessible", "this site conforms to WCAG
2.2 AA", or "this site is more accessible than one that scored `2 / 40`". The
first two need people; the third compares numbers with different
denominators.

A contract score says how closely a page follows one published design
contract. Read it as the engine's view of craft. It is separate from
accessibility, even where the two overlap.

A `null` is a result. It says the kit declined to print a number and names
the reason.
