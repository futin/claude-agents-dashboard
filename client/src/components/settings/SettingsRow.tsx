import type { ReactNode } from 'react';

/** One labelled setting: name + explanation on the left, the control on the right. */
export function SettingsRow({
  name, hint, children
}: { name: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span className="set-name">{name}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

/** A group of rows under a section heading. */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set-group">
      <div className="mdetail-label">{title}</div>
      {children}
    </section>
  );
}

/**
 * Segmented picker. Used instead of a `<select>` wherever there are three or
 * four options and seeing them all at once is worth the width — density, text
 * scale, on/off.
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

/** A bounded integer input. Commits on blur so half-typed numbers never clamp mid-keystroke. */
export function NumberField({
  value, min, max, unit, onCommit
}: { value: number; min: number; max: number; unit?: string; onCommit: (v: number) => void }) {
  return (
    <>
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
    </>
  );
}
