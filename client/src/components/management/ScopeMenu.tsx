import type { ProjectRef } from '../../../../shared/types';

interface Props {
  projects: ProjectRef[];
  selected: string;
  onSelect: (scope: string) => void;
}

/** Left pane: "Global" + recently-active projects, newest-first. */
export function ScopeMenu({ projects, selected, onSelect }: Props) {
  return (
    <div className="mgmt-menu">
      <div
        className={selected === 'global' ? 'mgmt-menu-item on' : 'mgmt-menu-item'}
        onClick={() => onSelect('global')}
      >
        <span className="mgmt-menu-name">Global</span>
        <span className="mgmt-menu-path">~/.claude</span>
      </div>
      {projects.map(p => (
        <div
          key={p.dirName}
          className={selected === p.dirName ? 'mgmt-menu-item on' : 'mgmt-menu-item'}
          onClick={() => onSelect(p.dirName)}
        >
          <span className="mgmt-menu-name">{p.name}</span>
          <span className="mgmt-menu-path">{p.path}</span>
        </div>
      ))}
    </div>
  );
}
