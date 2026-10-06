/** The widths the suite renders at, shared by `views.spec.ts` (shots) and `layout.spec.ts` (overflow) — a spec importing a spec would declare its tests twice. */

/** Each tier's `min-width` from docs/subsystems/breakpoints.md, 375 standing in for the phone base. */
export const FIXED_WIDTHS = [375, 640, 768, 1024, 1280, 1536];
/** `3xl` / `4xl` exist only in full content-width mode. */
export const FULL_WIDTHS = [1537, 1921];

/** The width × mode pairs every view is shot (and overflow-checked) at in daylight. */
export const DAYLIGHT_TIERS: { width: number; contentWidth: 'fixed' | 'full' }[] = [
  ...FIXED_WIDTHS.map((width) => ({ width, contentWidth: 'fixed' as const })),
  ...FULL_WIDTHS.map((width) => ({ width, contentWidth: 'full' as const }))
];
