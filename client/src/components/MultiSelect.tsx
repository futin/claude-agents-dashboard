import { useEffect, useRef, useState } from 'react';

export interface MultiOption {
  value: string;
  label: string;
}

/**
 * Compact toolbar facet: a button summarizing the current selection that opens
 * a checkbox popover. Empty `selected` = no filter ("All {label}"). React-only,
 * no deps. Closes on outside click / Esc.
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange
}: {
  label: string;
  options: MultiOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const summary =
    selected.length === 0
      ? `All ${label}`
      : selected.length === 1
        ? options.find(o => o.value === selected[0])?.label ?? selected[0]
        : `${selected.length} ${label}`;

  const toggle = (value: string) => {
    onChange(
      selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]
    );
  };

  return (
    <div className="tb-multi-wrap" ref={ref}>
      <button
        type="button"
        className="tb-multi"
        title={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {summary} ▾
      </button>
      {open && (
        <div className="tb-pop" role="menu">
          {options.length === 0 ? (
            <div className="tb-pop-empty">none</div>
          ) : (
            options.map(o => (
              <label key={o.value} className="tb-pop-row">
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  onChange={() => toggle(o.value)}
                />
                {o.label}
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
