/**
 * figures.mjs — hand-authored inline SVG, one per mermaid fence in the guide.
 *
 * A self-contained page cannot load mermaid.js, so every ```mermaid fence in the
 * markdown is replaced by the figure keyed `<doc-slug>:<ordinal>` below. Ordinals
 * are per document, zero-based, in source order. Add a fence to the markdown and
 * you must add a figure here — `build.mjs` fails loudly on a missing key rather
 * than emitting a page with a hole in it.
 *
 * Conventions (see the study skill's references/visuals.md):
 *  - viewBox only, never fixed width/height, so the figure scales to its column.
 *  - Colors come from CSS custom properties, never hex — the page themes the SVG.
 *  - Labels are real <text>, so they stay selectable and screen-reader legible.
 *  - Every marker id is unique across the page: all nine SVGs are inlined into
 *    ONE document, so a shared `id="arrow"` would have eight duplicates and every
 *    browser resolves the first one. `defs(key)` derives the id from the key.
 */

/** Arrowhead marker, id derived from the figure key so it is unique page-wide. */
function defs(key) {
  const id = `ar-${key.replace(/[^a-z0-9]+/gi, '-')}`;
  return {
    id,
    markup: `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5"
      markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--line)"/></marker></defs>`
  };
}

/** A rounded box with centred label lines. */
function box(x, y, w, h, lines, opts = {}) {
  const fill = opts.fill || 'var(--panel)';
  const stroke = opts.stroke || 'var(--line)';
  const size = opts.size || 12;
  const cx = x + w / 2;
  const total = lines.length;
  const start = y + h / 2 - ((total - 1) * (size + 3)) / 2 + size / 3;
  const text = lines
    .map((l, i) => `<text x="${cx}" y="${start + i * (size + 3)}">${l}</text>`)
    .join('');
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
    <g fill="var(--fg)" font-size="${size}" text-anchor="middle"
       font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${text}</g>`;
}

/** Straight arrow. */
function arrow(id, x1, y1, x2, y2, opts = {}) {
  const stroke = opts.stroke || 'var(--line)';
  const dash = opts.dash ? ` stroke-dasharray="4 3"` : '';
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}"
    stroke-width="1.5" marker-end="url(#${id})"${dash}/>`;
}

/** Small muted annotation. */
function note(x, y, s, anchor = 'middle') {
  return `<text x="${x}" y="${y}" fill="var(--muted)" font-size="11" text-anchor="${anchor}">${s}</text>`;
}

/* ------------------------------------------------------------------ README:0 */

function figWhole() {
  const { id, markup } = defs('whole');
  const scripts = [
    ['UserPromptSubmit', 'remote-decision.sh'],
    ['PreToolUse', 'ask-remote.sh'],
    ['PermissionRequest', 'plan-remote.sh'],
    ['PermissionRequest', 'permission-notify.sh'],
    ['Stop', 'stop-notify.sh']
  ];
  const stores = ['pending.ts', 'plans.ts', 'messages.ts', 'permissions.ts'];
  let s = markup;
  s += `<rect x="4" y="26" width="250" height="290" rx="8" fill="none" stroke="var(--line)"
    stroke-width="1" stroke-dasharray="5 4"/>`;
  s += note(129, 20, 'your terminal — Claude Code CLI');
  s += `<rect x="330" y="60" width="180" height="230" rx="8" fill="none" stroke="var(--line)"
    stroke-width="1" stroke-dasharray="5 4"/>`;
  s += note(420, 52, 'dashboard server :4173');

  scripts.forEach(([ev, sc], i) => {
    const y = 38 + i * 56;
    s += box(14, y, 230, 44, [ev, sc]);
  });
  stores.forEach((st, i) => {
    const y = 72 + i * 52;
    s += box(340, y, 160, 40, [st]);
  });
  // ask-remote → pending, plan-remote → plans, stop → messages, perm-notify → permissions
  s += arrow(id, 244, 116, 338, 92);
  s += arrow(id, 244, 172, 338, 144);
  s += arrow(id, 244, 284, 338, 196);
  s += arrow(id, 244, 228, 338, 248);
  s += note(292, 104, 'held', 'middle');
  s += note(300, 240, 'fire+forget', 'middle');
  // remote-decision has no server store — it prints context
  s += arrow(id, 244, 60, 300, 60, { dash: true });
  // Sits in the gap between the two dashed regions; further right it collides
  // with the "dashboard server" label (caught by the getBBox overlap check).
  s += note(288, 48, 'stdout only', 'middle');

  s += box(560, 150, 90, 60, ['your', 'phone'], { fill: 'var(--panel)', stroke: 'var(--accent)' });
  s += arrow(id, 510, 180, 558, 180, { stroke: 'var(--accent)' });

  return {
    title: 'Five hook scripts in the CLI POST to four in-memory stores on the dashboard, which the phone reads',
    caption: 'Five scripts. One only prints text; one only records a fact; the other three are the same mechanism three times.',
    svg: `<svg viewBox="0 0 660 326" role="img" xmlns="http://www.w3.org/2000/svg">
      <title>Five hook scripts in the CLI POST to four in-memory stores on the dashboard, which the phone reads</title>
      ${s}</svg>`
  };
}

/* -------------------------------------------------------------- sequence base */

/**
 * A sequence diagram: lifelines plus labelled arrows.
 * `msgs` entries are [fromIndex, toIndex, label, opts].
 */
function sequence(key, participants, msgs, opts = {}) {
  const { id, markup } = defs(key);
  const colW = opts.colW || 150;
  const top = 46;
  const step = opts.step || 34;
  const height = top + msgs.length * step + 26;
  const width = participants.length * colW;
  let s = markup;

  participants.forEach((p, i) => {
    const cx = i * colW + colW / 2;
    s += box(cx - colW / 2 + 8, 8, colW - 16, 30, [p], { size: 11 });
    s += `<line x1="${cx}" y1="38" x2="${cx}" y2="${height - 14}" stroke="var(--line)"
      stroke-width="1" stroke-dasharray="3 4"/>`;
  });

  msgs.forEach(([from, to, label, o = {}], i) => {
    const y = top + i * step;
    const x1 = from * colW + colW / 2;
    const x2 = to * colW + colW / 2;
    if (from === to) {
      s += `<path d="M ${x1} ${y - 8} q 34 0 34 9 q 0 9 -34 9" fill="none"
        stroke="var(--line)" stroke-width="1.5" marker-end="url(#${id})"/>`;
      s += note(x1 + 44, y + 2, label, 'start');
    } else {
      s += arrow(id, x1, y, x2, y, { stroke: o.accent ? 'var(--accent)' : 'var(--line)', dash: o.dash });
      s += note((x1 + x2) / 2, y - 6, label);
    }
  });

  return { width, height, svg: s, id };
}

/* -------------------------------------------------------------- lifecycle:0 */

function figTurn() {
  const parts = ['You', 'CLI', 'hooks', 'dashboard', 'the model'];
  const msgs = [
    [0, 1, 'type a prompt'],
    [1, 2, 'UserPromptSubmit'],
    [2, 3, 'GET /api/health (1s)'],
    [2, 1, 'stdout = instruction'],
    [1, 4, 'prompt + injection'],
    [4, 1, 'AskUserQuestion(...)'],
    [1, 2, 'PreToolUse'],
    [2, 3, 'POST questions/wait — HELD', { accent: true }],
    [0, 3, 'tap an option on the phone', { accent: true }],
    [3, 2, 'answered + reason', { accent: true }],
    [2, 1, 'deny + reason'],
    [1, 4, 'reads reason as the answer'],
    [4, 1, 'turn over'],
    [1, 2, 'Stop'],
    [2, 3, 'POST messages/wait — HELD'],
    [2, 1, 'block+reason, or exit 0']
  ];
  const { width, height, svg } = sequence('turn', parts, msgs, { colW: 152, step: 33 });
  const t = 'One turn: UserPromptSubmit injects context, PreToolUse holds for a phone answer, Stop holds again at the end';
  return {
    title: t,
    caption: 'The two held POSTs are the blocking hooks. Everything else returns in about a second.',
    svg: `<svg viewBox="0 0 ${width} ${height}" role="img" xmlns="http://www.w3.org/2000/svg">
      <title>${t}</title>${svg}</svg>`
  };
}

/* ------------------------------------------------------------- held-socket:0 */

function figHeld() {
  const parts = ['ask-remote.sh', 'serveQuestionWait', 'pending.ts', 'browser'];
  const msgs = [
    [0, 1, 'POST questions/wait'],
    [1, 1, 'gate: remoteAnswer? token? session?'],
    [1, 1, 'sanitizeQuestions(toolInput)'],
    [1, 2, 'register(sid, qs, timeout, resolve)'],
    [1, 1, 'RETURNS — res never ended', { accent: true }],
    [1, 1, 'maybeSend(push) — fire+forget'],
    [3, 1, 'GET sessions/:id/question'],
    [1, 3, 'the questions'],
    [3, 1, 'POST sessions/:id/answer'],
    [1, 2, 'answer(sid, body)'],
    [2, 2, 'settle → clear, delete, resolve'],
    [2, 0, 'resolve fires → curl returns', { accent: true }]
  ];
  const { width, height, svg } = sequence('held', parts, msgs, { colW: 176, step: 33 });
  const t = 'The handler registers a callback and returns without ending the response; the store fires it later';
  return {
    title: t,
    caption: 'The handler’s job is to NOT answer. The socket stays open until the store settles the entry.',
    svg: `<svg viewBox="0 0 ${width} ${height}" role="img" xmlns="http://www.w3.org/2000/svg">
      <title>${t}</title>${svg}</svg>`
  };
}

/* ------------------------------------------------------------- held-socket:1 */

function figRace() {
  const { id, markup } = defs('race');
  let s = markup;
  s += box(232, 14, 156, 40, ['Held'], { stroke: 'var(--accent)' });
  const outs = [
    ['Answered', 'browser POSTs', 'resolve(answered)'],
    ['TimedOut', 'deadline timer', 'resolve(timeout)'],
    ['Superseded', 're-register', 'resolve(superseded)'],
    ['Cancelled', 'socket closes', 'no resolve — nobody left']
  ];
  outs.forEach(([name, cause, effect], i) => {
    const y = 96 + i * 62;
    s += box(216, y, 188, 40, [name]);
    s += note(414, y + 24, effect, 'start');
    // Fan out of the Held box's bottom edge, each landing on its own outcome.
    s += arrow(id, 262 + i * 32, 54, 300, y - 2);
    s += note(208, y + 24, cause, 'end');
  });
  const t = 'A held wait can end four ways: answered, timed out, superseded, or cancelled when the hook dies';
  return {
    title: t,
    caption: 'Only Cancelled skips resolve — a closed socket means there is nobody left to answer to.',
    svg: `<svg viewBox="0 0 620 420" role="img" xmlns="http://www.w3.org/2000/svg">
      <title>${t}</title>${s}</svg>`
  };
}

/* --------------------------------------------------------------- stop-loop:0 */

function figStopLoop() {
  const { id, markup } = defs('stoploop');
  let s = markup;
  s += box(216, 12, 170, 38, ['turn ends']);
  s += box(216, 84, 170, 38, ['the gate stack']);
  s += box(24, 84, 150, 38, ['notify_fallback']);
  s += box(216, 160, 170, 38, ['held ≤600s'], { stroke: 'var(--accent)' });
  s += box(216, 240, 170, 38, ['block the stop'], { stroke: 'var(--accent)' });
  s += box(440, 240, 156, 38, ['session stops']);

  s += arrow(id, 301, 50, 301, 82);
  s += arrow(id, 214, 103, 176, 103);
  s += note(196, 96, 'at desk / off / bg work', 'middle');
  s += arrow(id, 301, 122, 301, 158);
  s += note(384, 143, 'away + remoteAnswer on', 'start');
  s += arrow(id, 301, 198, 301, 238);
  s += note(384, 222, 'you type a follow-up', 'start');
  s += arrow(id, 386, 259, 438, 259);
  s += note(412, 300, 'CLI 8-block cap', 'middle');
  s += arrow(id, 386, 180, 438, 180, { dash: true });
  s += note(518, 176, 'timeout / dismiss', 'middle');
  s += note(518, 192, '/ released', 'middle');
  // the loop back up
  s += `<path d="M 216 259 q -80 0 -80 -60 q 0 -60 80 -180" fill="none" stroke="var(--accent)"
    stroke-width="1.5" marker-end="url(#${id})" stroke-dasharray="5 4"/>`;
  s += note(96, 200, 'model continues', 'middle');
  s += note(96, 216, '→ Stop fires again', 'middle');
  s += arrow(id, 99, 122, 99, 236);
  s += arrow(id, 174, 255, 214, 255, { dash: true });

  const t = 'A blocking Stop hook loops: the model continues and Stop fires again, up to eight times';
  return {
    title: t,
    caption: 'The loop bound lives in the CLI (8 blocks), not in the script — which is why the script needs no counter.',
    svg: `<svg viewBox="0 0 620 320" role="img" xmlns="http://www.w3.org/2000/svg">
      <title>${t}</title>${s}</svg>`
  };
}

/* --------------------------------------------------------------- fail-open:0 */

function figGates() {
  const { id, markup } = defs('gates');
  let s = markup;
  const gates = [
    'CLAUDECODE=1 and jq present?',
    'GET /api/health — 1s hard cap',
    'remoteAnswer? (env AND toggle)',
    'ioreg idle ≥ threshold?',
    'POST wait — HELD ≤600s',
    'status == answered?'
  ];
  // Each gate feeds a shared vertical bail-out rail at x=392, which enters `exit 0` once.
  gates.forEach((g, i) => {
    const y = 14 + i * 58;
    s += box(20, y, 300, 40, [g], { size: 11.5 });
    if (i < gates.length - 1) s += arrow(id, 170, y + 40, 170, y + 56);
    s += `<line x1="320" y1="${y + 20}" x2="392" y2="${y + 20}" stroke="var(--line)"
      stroke-width="1.5" stroke-dasharray="4 3"/>`;
  });
  s += `<line x1="392" y1="34" x2="392" y2="324" stroke="var(--line)" stroke-width="1.5"
    stroke-dasharray="4 3"/>`;
  s += arrow(id, 392, 180, 436, 180, { dash: true });
  s += box(438, 156, 130, 48, ['exit 0'], { stroke: 'var(--bad)' });
  s += box(20, 366, 300, 44, ['emit deny + reason'], { stroke: 'var(--accent)' });
  s += arrow(id, 170, 346, 170, 364, { stroke: 'var(--accent)' });
  s += box(438, 250, 168, 60, ['terminal dialog renders', 'exactly as before']);
  s += arrow(id, 503, 204, 503, 248);
  s += note(503, 138, '12 of 13 paths', 'middle');

  const t = 'Six gates, each with the same bail-out: exit 0, and the terminal dialog renders as it always did';
  return {
    title: t,
    caption: 'Every edge out of the stack except one lands on exit 0. Fail-open toward the terminal is the invariant.',
    svg: `<svg viewBox="0 0 620 420" role="img" xmlns="http://www.w3.org/2000/svg">
      <title>${t}</title>${s}</svg>`
  };
}

/* --------------------------------------------------------------- fail-open:1 */

function figDirections() {
  const { id, markup } = defs('dirs');
  let s = markup;
  s += box(20, 128, 150, 52, ['ioreg', 'unreadable'], { stroke: 'var(--accent)' });
  const sites = [
    ['ask-remote.sh', "don't intercept", 'no phone option'],
    ['notify.ts', 'push anyway', 'one extra buzz'],
    ['sweepIdle', "don't release", 'hold runs to deadline']
  ];
  sites.forEach(([site, act, cost], i) => {
    const y = 24 + i * 106;
    s += box(232, y, 168, 56, [site, act]);
    s += arrow(id, 170, 154, 230, y + 28);
    s += box(438, y, 168, 56, ['worst case:', cost], { size: 11 });
    s += arrow(id, 400, y + 28, 436, y + 28);
  });
  const t = 'One unreadable signal, three call sites, three opposite defaults — each derived from its own cost of being wrong';
  return {
    title: t,
    caption: 'Each site asks what being wrong costs here, not what the project normally does.',
    svg: `<svg viewBox="0 0 620 300" role="img" xmlns="http://www.w3.org/2000/svg">
      <title>${t}</title>${s}</svg>`
  };
}

/* ------------------------------------------------------------------ config:0 */

function figLadder() {
  const { id, markup } = defs('ladder');
  let s = markup;
  const rungs = [
    ['curl -m 1', 'health probe', 'the hook'],
    ['600s', 'the actual window', "server's setTimeout"],
    ['curl -m 615', 'hung-server backstop', 'the hook'],
    ['timeout: 630', "the CLI's kill", 'Claude Code'],
    ['5s … 1800s', 'clampTimeout bound', 'pending.ts']
  ];
  rungs.forEach(([v, what, owner], i) => {
    const y = 16 + i * 62;
    s += box(20, y, 150, 46, [v], { stroke: i === 1 ? 'var(--accent)' : 'var(--line)' });
    s += `<g fill="var(--fg)" font-size="12"><text x="188" y="${y + 22}">${what}</text></g>`;
    s += note(188, y + 38, `owner: ${owner}`, 'start');
    if (i < rungs.length - 1) s += arrow(id, 95, y + 46, 95, y + 60);
  });
  s += note(520, 60, 'each layer is', 'middle');
  s += note(520, 76, 'strictly larger', 'middle');
  s += note(520, 92, 'than the one', 'middle');
  s += note(520, 108, 'it guards', 'middle');

  const t = 'Four timeouts guard one wait, each strictly larger than the layer below it';
  return {
    title: t,
    caption: 'Getting the ladder wrong degrades to the terminal dialog — never to a broken session.',
    svg: `<svg viewBox="0 0 620 340" role="img" xmlns="http://www.w3.org/2000/svg">
      <title>${t}</title>${s}</svg>`
  };
}

/* ------------------------------------------------------------------ config:1 */

function figStacks() {
  const { id, markup } = defs('stacks');
  let s = markup;
  s += note(150, 16, 'stack 1 — is the feature on?');
  s += box(20, 26, 120, 44, ['REMOTE_ANSWER', 'env']);
  s += box(160, 26, 120, 44, ['UI toggle']);
  s += box(70, 100, 180, 44, ['available AND enabled'], { stroke: 'var(--accent)' });
  s += arrow(id, 80, 70, 140, 98);
  s += arrow(id, 220, 70, 180, 98);
  s += note(150, 164, 'stack 2 — should THIS one wait?');
  s += box(70, 174, 180, 44, ['idle ≥ threshold?', 'in the hook']);
  s += arrow(id, 160, 144, 160, 172);

  s += note(452, 16, 'stack 3 — should it push?');
  const layers = ['policy.enabled', 'events[event]', 'requireRemoteAnswer', 'requireAutoMode', 'requireAfk'];
  layers.forEach((l, i) => {
    const y = 26 + i * 46;
    s += box(360, y, 190, 34, [l], { size: 11.5 });
    if (i < layers.length - 1) s += arrow(id, 455, y + 34, 455, y + 44);
  });
  s += note(452, 268, 'orthogonal — governs pushes, not waits');

  const t = 'Three independent gate stacks: is the feature on, should this one wait, and should it push';
  return {
    title: t,
    caption: 'The hook is only ever told the product of stack 1. It never learns which layer said no.',
    svg: `<svg viewBox="0 0 620 288" role="img" xmlns="http://www.w3.org/2000/svg">
      <title>${t}</title>${s}</svg>`
  };
}

/** key → { title, caption, svg }. Keys are `<doc-slug>:<fence ordinal>`. */
export const FIGURES = {
  'README:0': figWhole(),
  'lifecycle:0': figTurn(),
  'held-socket:0': figHeld(),
  'held-socket:1': figRace(),
  'stop-loop:0': figStopLoop(),
  'fail-open:0': figGates(),
  'fail-open:1': figDirections(),
  'config:0': figLadder(),
  'config:1': figStacks()
};
