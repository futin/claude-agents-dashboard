export type Section = 'sessions' | 'management';

interface Props {
  section: Section;
  onChange: (s: Section) => void;
}

/** Top-level section switch: live sessions monitor vs. config management. */
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
    </div>
  );
}
