export type Section = 'sessions' | 'management' | 'analytics';

interface Props {
  section: Section;
  onChange: (s: Section) => void;
}

/** Top-level section switch: live sessions monitor · config management · analytics. */
export function SectionTabs({ section, onChange }: Props) {
  return (
    <div className="tabs">
      <button
        className={section === 'sessions' ? 'tab on' : 'tab'}
        onClick={() => onChange('sessions')}
      >
        Sessions
      </button>
      <button
        className={section === 'management' ? 'tab on' : 'tab'}
        onClick={() => onChange('management')}
      >
        Management
      </button>
      <button
        className={section === 'analytics' ? 'tab on' : 'tab'}
        onClick={() => onChange('analytics')}
      >
        Analytics
      </button>
    </div>
  );
}
