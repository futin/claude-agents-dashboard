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

/** Top-level section switch: live sessions monitor · config management · analytics · settings. */
export function SectionTabs({ section, onChange }: Props) {
  return (
    <div className="tabs">
      {TABS.map(t => (
        <button
          key={t.id}
          className={section === t.id ? 'tab on' : 'tab'}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
