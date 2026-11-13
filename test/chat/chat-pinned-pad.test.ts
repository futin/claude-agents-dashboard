/**
 * Guards the one mechanism that keeps a pinned wait panel from swallowing the newest turn: the transcript's bottom padding tracks the
 * pinned layer's live height (`--pinned-h`), so the tail can always be scrolled out from under a composer.
 *
 * Text assertions on `client/src/styles.css` rather than a rendered check, because there is no DOM in this suite — and because the defect
 * this guards is precisely a *missed copy*: `.chat-body`'s padding is declared three times (base, phone, the `min-width:768px` restore) and
 * fixing two of them looks fixed at one width and broken at the other.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Nearest ancestor of `from` that holds a `package.json`. */
function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${from}`);
    dir = parent;
  }
}

const ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const CSS = fs.readFileSync(path.join(ROOT, 'client', 'src', 'styles.css'), 'utf8');
const DRAWER = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'ChatDrawer.tsx'), 'utf8');

/** Every `.chat-body{…}` declaration body in the stylesheet, in source order. */
function chatBodyRules(): string[] {
  const out: string[] = [];
  for (let i = CSS.indexOf('.chat-body{'); i !== -1; i = CSS.indexOf('.chat-body{', i + 1)) {
    const open = CSS.indexOf('{', i);
    const close = CSS.indexOf('}', open);
    out.push(CSS.slice(open + 1, close));
  }
  return out;
}

export function run(): number {
  console.log('\n=== chat pinned padding ===\n');
  let p = 0, f = 0;

  if (test('the stylesheet still declares .chat-body at all three widths', () => {
    assert.strictEqual(chatBodyRules().length, 3);
  })) p++; else f++;

  // The one that bit: the phone rule and the desktop restore each re-declare
  // `padding` in full, so a constant left in EITHER hides the tail at that width.
  if (test('every .chat-body padding clears the pinned layer', () => {
    const withPad = chatBodyRules().filter(r => /padding:/.test(r));
    assert.ok(withPad.length >= 3, `only ${withPad.length} of the .chat-body rules set padding`);
    for (const rule of withPad) {
      const decl = /padding:([^;}]*)/.exec(rule);
      assert.ok(decl, 'padding declaration did not parse');
      assert.match(decl[1], /var\(--pinned-h/, `a .chat-body padding is constant again: padding:${decl[1].trim()}`);
    }
  })) p++; else f++;

  if (test('the pad keeps its own 40px of air on top of the panel', () => {
    for (const rule of chatBodyRules().filter(r => /padding:/.test(r))) {
      assert.match(rule, /calc\(40px \+ var\(--pinned-h,0px\)\)/);
    }
  })) p++; else f++;

  // Nothing else writes the property, so if the drawer stops measuring, every
  // rule above silently falls back to its 0px default and the bug is back.
  if (test('ChatDrawer measures the pinned layer and writes --pinned-h', () => {
    assert.match(DRAWER, /className="chat-pinned" ref=\{pinnedRef\}/);
    assert.match(DRAWER, /new ResizeObserver\(measure\)/);
    assert.match(DRAWER, /setProperty\('--pinned-h'/);
  })) p++; else f++;

  // `.shell{zoom}` multiplies getBoundingClientRect but not the layout box, and
  // what the drawer writes back is a style px — the rect would be wrong at any
  // text scale but 100%.
  if (test('the measurement is offsetHeight, not a bounding rect', () => {
    assert.match(DRAWER, /pinned\.offsetHeight/);
    assert.ok(
      !/pinned\.getBoundingClientRect/.test(DRAWER),
      'the pinned layer is measured by rect — that is zoom-scaled, offsetHeight is not'
    );
  })) p++; else f++;

  console.log(`\n${p} passed, ${f} failed`);
  return f;
}
