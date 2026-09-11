import type { ReactNode, SelectHTMLAttributes } from 'react';

import type { SettingsScope } from '../../lib/settings';

/**
 * One labelled setting: name + explanation on the left, the control on the
 * right. `below` is for a control too wide for the right-hand slot — the theme
 * swatches — which then spans the row under the label instead.
 */
export function SettingsRow({
  name, hint, below, children
}: { name: string; hint?: ReactNode; below?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span className="set-name">{name}</span>
        {hint && <span className="set-hint">{hint}</span>}
        {below}
      </div>
      {children && <div className="set-control">{children}</div>}
    </div>
  );
}

/**
 * A sub-category of settings as one card: title + one-line subtitle, then the
 * rows. The card is the reference design's pattern (DESIGN.md §7, "title +
 * subtitle pair"), so `sub` is required — a card with a bare title reads as
 * unfinished there.
 */
export function SettingsGroup({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <section className="set-group">
      <div className="set-group-title">{title}</div>
      <div className="set-group-sub">{sub}</div>
      <div className="set-rows">{children}</div>
    </section>
  );
}

/**
 * The page header of a Settings page — on the app ground, not in a card: the
 * scope as the title, a pill saying what that scope means in storage terms,
 * one line under. `tabs` is the phone's copy of the rail's tree (see
 * `.set-tabs` in styles.css), mounted always and shown only there.
 */
export function SettingsBand({
  scope, title, sub, tabs
}: { scope: SettingsScope; title: string; sub: string; tabs?: ReactNode }) {
  return (
    <div className="set-band">
      <div>
        <div className="set-band-title">
          {title}
          <ScopePill scope={scope} />
        </div>
        <div className="set-band-sub">{sub}</div>
      </div>
      {tabs && <div className="set-tabs">{tabs}</div>}
    </div>
  );
}

/** Where a scope's settings live, in the user's terms — the one word the two pages differ by. */
function ScopePill({ scope }: { scope: SettingsScope }) {
  return (
    <span className={scope === 'shared' ? 'set-scope shared' : 'set-scope'}>
      <i aria-hidden="true" />
      {scope === 'shared' ? 'every device' : 'this browser'}
    </span>
  );
}

/**
 * Segmented picker. Used instead of a `<select>` wherever there are two to
 * four options and seeing them all at once is worth the width — density, text
 * scale, on/off — and, on the phone, as the sub-view switch of a section.
 */
export function Segmented<T extends string | number>({
  value, options, onChange, disabled
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  /** For a setting the server can't act on — the switch would flip and do nothing. */
  disabled?: boolean;
}) {
  return (
    <div className="set-seg" role="group">
      {options.map(o => (
        <button
          key={String(o.value)}
          className={o.value === value ? 'on' : undefined}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A `<select>` in the board's control family. The wrapper exists for the
 * chevron: a native select cannot carry a pseudo-element, and a background
 * SVG would need a literal colour, which the theme system forbids — so the
 * span's `::after` draws it from `--ink2` and the select goes `appearance:none`.
 */
export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="set-select">
      <select {...props}>{children}</select>
    </span>
  );
}

/**
 * A bounded integer input. Commits on blur so half-typed numbers never clamp
 * mid-keystroke. The unit sits inside the box, so the box is the wrapper and
 * the input inside it is borderless.
 */
export function NumberField({
  value, min, max, unit, onCommit
}: { value: number; min: number; max: number; unit?: string; onCommit: (v: number) => void }) {
  return (
    <span className="set-field">
      <input
        type="number"
        defaultValue={value}
        min={min}
        max={max}
        key={value} /* re-seed when the value changes from elsewhere (e.g. Reset) */
        onBlur={e => onCommit(Number(e.currentTarget.value))}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      {unit && <span className="set-unit">{unit}</span>}
    </span>
  );
}
