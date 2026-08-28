export type Section = 'sessions' | 'management' | 'analytics' | 'usage' | 'settings';

const TABS: { id: Section; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'management', label: 'Management' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'usage', label: 'Usage Forecast' },
  { id: 'settings', label: 'Settings' }
];

/** Whether a stored/persisted string still names a section this build has. */
export function isSection(v: unknown): v is Section {
  return TABS.some(t => t.id === v);
}

interface Props {
  section: Section;
  onChange: (s: Section) => void;
}

/**
 * Top-level section switch: live sessions monitor · config management ·
 * session analytics · account usage forecast · settings. A rail down the left edge on desktop, a horizontal
 * scroll strip below 700px — see docs/superpowers/specs/2026-08-15-side-rail-nav-design.md.
 */
export function SideRail({ section, onChange }: Props) {
  return (
    <nav className="rail" aria-label="Sections">
      {/* the app's only wordmark — Header.tsx deliberately has no <h1> */}
      <h1 className="rail-brand">
        <span className="rail-kicker">Claude</span>
        <br />
        Dashboard
      </h1>
      {TABS.map(t => (
        <button
          key={t.id}
          className={section === t.id ? 'rail-link on' : 'rail-link'}
          aria-current={section === t.id ? 'page' : undefined}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
