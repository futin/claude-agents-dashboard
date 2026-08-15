export type Section = 'sessions' | 'management' | 'analytics' | 'settings';

const TABS: { id: Section; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'management', label: 'Management' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'settings', label: 'Settings' }
];

interface Props {
  section: Section;
  onChange: (s: Section) => void;
}

/**
 * Top-level section switch: live sessions monitor · config management ·
 * analytics · settings. A rail down the left edge on desktop, a horizontal
 * scroll strip below 700px — see docs/superpowers/specs/2026-08-15-side-rail-nav-design.md.
 */
export function SideRail({ section, onChange }: Props) {
  return (
    <nav className="rail" aria-label="Sections">
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
