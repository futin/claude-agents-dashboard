import assert from 'node:assert';
import { isValidElement, type ReactElement } from 'react';

import { LOAD_FAILED_TEXT, LoadBoundary } from '../../client/src/components/LoadBoundary.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Props = ConstructorParameters<typeof LoadBoundary>[0];

/** A boundary driven by hand: no DOM and no renderer, so a failed chunk is simulated by applying `getDerivedStateFromError` the way React would. */
function failed(props: Props): LoadBoundary {
  const b = new LoadBoundary(props);
  b.state = { ...b.state, ...LoadBoundary.getDerivedStateFromError() };
  return b;
}

/** The rendered notice, asserted to be one element with a text span and a button. */
function notice(b: LoadBoundary): { el: ReactElement<{ className: string; role: string; children: ReactElement[] }>; button: ReactElement<{ onClick: () => void }> } {
  const el = b.render();
  assert.ok(isValidElement(el), 'a failed boundary renders an element');
  const typed = el as ReactElement<{ className: string; role: string; children: ReactElement[] }>;
  const button = typed.props.children.find(c => c.type === 'button');
  assert.ok(button, 'the notice carries a button');
  return { el: typed, button: button as ReactElement<{ onClick: () => void }> };
}

export function run(): number {
  console.log('\nload-boundary');
  let p = 0, f = 0;

  if (test('a boundary that has not caught anything renders its children unchanged', () => {
    const child = 'the section';
    assert.strictEqual(new LoadBoundary({ children: child }).render(), child);
  })) p++; else f++;

  if (test('a thrown chunk error moves the boundary to failed, so React draws the notice instead of unmounting the root', () => {
    assert.deepStrictEqual(LoadBoundary.getDerivedStateFromError(), { failed: true });
  })) p++; else f++;

  if (test('once failed it renders an alert with the reload text in place of its children', () => {
    const { el } = notice(failed({ children: 'the section' }));
    assert.strictEqual(el.props.role, 'alert');
    assert.strictEqual(el.props.className, 'load-failed');
    assert.ok(el.props.children.some(c => c.props && (c.props as { children?: unknown }).children === LOAD_FAILED_TEXT));
  })) p++; else f++;

  if (test('the Reload button calls the reload it was given', () => {
    let reloads = 0;
    const { button } = notice(failed({ children: 'x', reload: () => { reloads++; } }));
    button.props.onClick();
    assert.strictEqual(reloads, 1);
  })) p++; else f++;

  if (test('the float variant, for a drawer or sheet, adds the float class', () => {
    assert.strictEqual(notice(failed({ children: 'x', variant: 'float' })).el.props.className, 'load-failed float');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
