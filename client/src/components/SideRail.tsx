import { SECTIONS, type Section } from '../lib/sections';
import { useSettings } from '../hooks/useSettings';
import type { Settings } from '../lib/settings';

interface Props {
  section: Section;
  onChange: (s: Section) => void;
}

/**
 * Top-level section switch: live sessions monitor · config management ·
 * session analytics · account usage forecast · settings. A rail down the left edge on desktop, a horizontal
 * scroll strip below 700px — see docs/superpowers/specs/2026-08-15-side-rail-nav-design.md.
 *
 * Each row carries a 20px outline icon at 1.5px stroke, in ink rather than any
 * accent — an icon here names the section, it never signals state (DESIGN.md §6).
 * They are inline SVG and not a font or a sprite: five glyphs, drawn once, with
 * no request and nothing to keep in sync.
 */

/** One glyph per section id, so a new section fails to compile without one. */
const ICONS: Record<Section, JSX.Element> = {
  sessions: <><rect x="2.5" y="3" width="15" height="5.5" rx="1.8" /><rect x="2.5" y="11.5" width="15" height="5.5" rx="1.8" /></>,
  usage: <path d="M3.5 16.5v-5M8.5 16.5v-13M13 16.5v-7.5M17 16.5v-10" />,
  management: <><rect x="3" y="3.5" width="14" height="13" rx="1.8" /><path d="M3 8h14M8 8v8.5" /></>,
  analytics: <path d="M3 14.5l4.5-6 3.5 3.5L17 5" />,
  settings: <><circle cx="10" cy="10" r="2.6" /><path d="M10 2.6v2.2M10 15.2v2.2M2.6 10h2.2M15.2 10h2.2M4.8 4.8l1.6 1.6M13.6 13.6l1.6 1.6M15.2 4.8l-1.6 1.6M6.4 13.6l-1.6 1.6" /></>
};

/**
 * The sections that have sub-views, and the per-device setting each tree
 * writes. Two today — Usage (Forecast / Token value) and Settings (Local /
 * Shared) — drawn from one table so a third gets the same tree for one line.
 */
type SubKey = 'usageTab' | 'settingsTab';
interface SubNav<K extends SubKey> { key: K; items: { value: Settings[K]; label: string }[] }
const SUBNAV: Partial<Record<Section, SubNav<'usageTab'> | SubNav<'settingsTab'>>> = {
  usage: { key: 'usageTab', items: [{ value: 'forecast', label: 'Forecast' }, { value: 'rates', label: 'Token value' }] },
  settings: { key: 'settingsTab', items: [{ value: 'local', label: 'Local' }, { value: 'shared', label: 'Shared' }] }
};

function Icon({ section }: { section: Section }) {
  return (
    <svg
      className="rail-ic"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[section]}
    </svg>
  );
}

export function SideRail({ section, onChange }: Props) {
  // A section's sub-views are navigation, so they live in the nav: on a desktop
  // rail this is the only control for them, and the section renders whichever
  // is chosen. Per-device, like every other setting.
  const { settings, update } = useSettings();

  return (
    <nav className="rail" aria-label="Sections">
      {/* the app's only wordmark — Header.tsx deliberately has no <h1> */}
      <h1 className="rail-brand">
        {/* The mock's own shape: the dot outside the two-line text block and
            centred against it. No <br> — the kicker is a block, and a break
            after it opened a second, empty line that pushed the name away. */}
        <span className="rail-dot" aria-hidden="true" />
        <span>
          <span className="rail-kicker">Claude</span>
          Dashboard
        </span>
      </h1>
      {SECTIONS.map(t => (
        <div key={t.id} className="rail-group">
          {/* Settings is the one section that is about the board rather than
              about the work, so it sits under a rule like the mock's. */}
          {t.id === 'settings' && <div className="rail-div" />}
          <button
            className={section === t.id ? 'rail-link on' : 'rail-link'}
            aria-current={section === t.id ? 'page' : undefined}
            onClick={() => onChange(t.id)}
          >
            <Icon section={t.id} />
            {t.label}
          </button>
          {SUBNAV[t.id] && section === t.id && (
            /* Only while the section is open: a tree hanging off a row you are
               not on is a second navigation depth to read past on every glance,
               and on the phone strip it would be two more chips in the scroll. */
            <div className="rail-sub">
              {SUBNAV[t.id]!.items.map(s => {
                const sub = SUBNAV[t.id]!;
                const on = settings[sub.key] === s.value;
                return (
                  <button
                    key={s.value}
                    className={on ? 'rail-sublink on' : 'rail-sublink'}
                    aria-current={on ? 'true' : undefined}
                    /* the computed key loses the per-key value type; the table
                       above is what guarantees `s.value` fits `sub.key` */
                    onClick={() => update({ [sub.key]: s.value } as Partial<Settings>)}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
