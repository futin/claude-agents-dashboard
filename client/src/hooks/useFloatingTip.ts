import { useCallback, useEffect, useRef } from 'react';

/**
 * The one floating explanation panel, and the handlers that drive it.
 *
 * Extracted from `UsageProfile` when the token-value card needed the same
 * panel for its ⓘ glyphs. **No `title` attributes anywhere:** this board is
 * read from a phone, where `title` never fires — a real element is the only
 * tooltip that exists on touch.
 *
 * The panel is written to **directly**, never through state: a pointermove that
 * re-rendered 168 heatmap cells to move one box would be absurd. The consumer
 * mounts `<div className="up-tip" ref={tipRef} role="tooltip" aria-hidden="true" />`
 * itself; this hook renders nothing.
 *
 * Two handler bundles, because the two marks want different gestures:
 * {@link TipHandlers} is hover-only, for a grid of marks a pointer sweeps
 * across; {@link PinHandlers} adds click-to-pin, for a glyph whose panel has to
 * stay open long enough to read.
 */

/**
 * The handler bundle a hoverable mark spreads.
 *
 * Typed against `Element`, not `HTMLElement`: the same bundle is spread onto the
 * heatmap's `<div>` cells and the strip's `<rect>` hit columns.
 */
export interface TipHandlers {
  onPointerEnter: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onFocus: (e: React.FocusEvent<Element>) => void;
  onBlur: () => void;
}

/** {@link TipHandlers} plus the click that pins the panel open. */
export interface PinHandlers extends TipHandlers {
  onClick: (e: React.MouseEvent<Element>) => void;
}

export function useFloatingTip(): {
  tipRef: React.RefObject<HTMLDivElement>;
  tipHandlers: (text: string) => TipHandlers;
  pinHandlers: (text: string) => PinHandlers;
  hide: () => void;
} {
  const tipRef = useRef<HTMLDivElement>(null);
  /** The mark a *keyboard*-shown or pinned tooltip belongs to; null when pointer-shown. */
  const anchorRef = useRef<Element | null>(null);
  /**
   * The element whose click pinned the panel open, or null.
   *
   * A ref and not state, and `aria-expanded` is set on the DOM node by hand
   * below: pinning must not re-render the rows, and the attribute is rendered
   * once as `false` and never touched by React again, so there is nothing for
   * React to fight over.
   */
  const pinnedRef = useRef<Element | null>(null);

  const placeTip = useCallback((x: number, y: number) => {
    const tip = tipRef.current;
    if (!tip) return;
    // Measure from the origin, never from wherever the panel was last left.
    // It is `position: fixed` with no `right`, so the viewport edge caps its
    // available width: measured while sitting near the right edge it reports a
    // *narrower* box than it will occupy once moved, and the clamp below then
    // lets it hang off the screen by the difference.
    tip.style.left = '0px';
    tip.style.top = '0px';
    const w = tip.offsetWidth;
    // `.shell{zoom:var(--font-scale)}` puts this fixed-positioned panel in a
    // *zoomed* coordinate space: its left/top are multiplied by the text scale,
    // while clientX/Y (and getBoundingClientRect) stay in visual viewport px.
    // At scale 100% the two spaces coincide and the bug is invisible; at 125%
    // the panel lands 25% further down-right than the pointer, an error that
    // grows with page position. Divide the visual coords (and the viewport
    // width the clamp compares against) back into the panel's own space.
    const z = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--font-scale')
    ) || 1;
    const vx = x / z, vy = y / z;
    tip.style.left =
      Math.max(8, Math.min(vx + 14, window.innerWidth / z - w - 8)) + 'px';
    // Beside the pointer at a constant offset — never above it, and with no
    // vertical clamp. The panel used to sit above the mark and clamp against
    // the viewport, but a clamp has an engage point, and crossing it reads as
    // the panel drifting around the pointer mid-sweep: walking down the grid,
    // the tip held still near the top edge and then started moving. A constant
    // offset keeps the pointer→panel distance identical on every cell. The
    // price is that the last ~60px above the bottom edge can shave the panel's
    // final lines — accepted; that is the very trade the clamp reversed.
    tip.style.top = (vy - 14) + 'px';
  }, []);

  const showTip = useCallback((text: string, x: number, y: number) => {
    const tip = tipRef.current;
    if (!tip) return;
    tip.textContent = text;   // never innerHTML; the CSS keeps the newlines
    tip.style.opacity = '1';
    placeTip(x, y);
  }, [placeTip]);

  const hideTip = useCallback(() => {
    const tip = tipRef.current;
    if (tip) tip.style.opacity = '0';
  }, []);

  /** Drop the pin, restoring the attribute the button rendered with. */
  const unpin = useCallback(() => {
    pinnedRef.current?.setAttribute('aria-expanded', 'false');
    pinnedRef.current = null;
  }, []);

  const hide = useCallback(() => { unpin(); hideTip(); }, [unpin, hideTip]);

  /** Anchor the panel to an element rather than to the pointer. */
  const showAt = useCallback((text: string, el: Element) => {
    const r = el.getBoundingClientRect();
    showTip(text, r.right, r.top);
  }, [showTip]);

  // A shown tooltip is positioned in viewport coordinates, so a scroll would
  // strand it — the panel holding still while the mark slides out from under it.
  // `capture` because the scroller is an ancestor, not the window.
  //
  // A *keyboard*-shown or *pinned* tooltip follows its mark instead of hiding:
  // tabbing to an off-screen cell makes the browser scroll it into view, and
  // hiding on that scroll would blank the tooltip the focus had just opened.
  // A pin has the same claim — it was opened deliberately and is being read.
  useEffect(() => {
    const onScroll = () => {
      const anchor = anchorRef.current;
      if (anchor && (pinnedRef.current === anchor || document.activeElement === anchor)) {
        const r = anchor.getBoundingClientRect();
        placeTip(r.right, r.top);
        return;
      }
      hide();
    };
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', hide);
    };
  }, [hide, placeTip]);

  // Escape, and a press anywhere outside the pinned button and the panel, close
  // a pinned tip. Registered unconditionally rather than only while pinned: two
  // idle listeners cost nothing, and an effect that re-subscribed on every pin
  // would need the pin in state, which is the re-render this hook avoids.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && pinnedRef.current) hide(); };
    const onDown = (e: PointerEvent) => {
      const pin = pinnedRef.current;
      if (!pin) return;
      const t = e.target as Node | null;
      if (t && (pin.contains(t) || tipRef.current?.contains(t))) return;
      hide();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [hide]);

  /** Hover / press / focus handlers for one hoverable mark. */
  const tipHandlers = useCallback((text: string): TipHandlers => ({
    onPointerEnter: (e: React.PointerEvent) => {
      anchorRef.current = null;          // pointer-shown: a scroll should hide it
      showTip(text, e.clientX, e.clientY);
    },
    onPointerMove: (e: React.PointerEvent) => placeTip(e.clientX, e.clientY),
    onPointerLeave: hideTip,
    onPointerCancel: hideTip,
    // Keyboard: anchor to the mark itself, since there is no pointer.
    onFocus: (e: React.FocusEvent<Element>) => {
      anchorRef.current = e.currentTarget;
      showAt(text, e.currentTarget);
    },
    onBlur: () => { anchorRef.current = null; hideTip(); }
  }), [showTip, showAt, placeTip, hideTip]);

  /**
   * The same gestures plus click-to-pin, for a ⓘ glyph.
   *
   * **Why the pin exists at all:** on touch the sequence is pointerenter →
   * pointerleave → click, so hover alone shows the panel on touch-down and
   * hides it on lift — far too fast to read a definition. The click is what
   * makes one tap open it and the next tap close it, while a mouse still gets
   * plain hover. While pinned, hover is inert: a pointer wandering off the
   * glyph must not close a panel the reader deliberately opened.
   */
  const pinHandlers = useCallback((text: string): PinHandlers => ({
    onPointerEnter: (e: React.PointerEvent) => {
      if (pinnedRef.current) return;
      anchorRef.current = null;
      showTip(text, e.clientX, e.clientY);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (pinnedRef.current) return;
      placeTip(e.clientX, e.clientY);
    },
    onPointerLeave: () => { if (!pinnedRef.current) hideTip(); },
    onPointerCancel: () => { if (!pinnedRef.current) hideTip(); },
    onFocus: (e: React.FocusEvent<Element>) => {
      if (pinnedRef.current) return;
      anchorRef.current = e.currentTarget;
      showAt(text, e.currentTarget);
    },
    onBlur: () => { anchorRef.current = null; hide(); },
    onClick: (e: React.MouseEvent<Element>) => {
      const el = e.currentTarget;
      if (pinnedRef.current === el) { hide(); return; }
      unpin();                            // a click on another ⓘ moves the pin
      pinnedRef.current = el;
      anchorRef.current = el;             // so a scroll moves it with the button
      el.setAttribute('aria-expanded', 'true');
      showAt(text, el);
    }
  }), [showTip, showAt, placeTip, hideTip, hide, unpin]);

  return { tipRef, tipHandlers, pinHandlers, hide };
}
