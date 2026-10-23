/** Current ids put the family first: `claude-opus-5-5`, `claude-sonnet-4-5-20250929`, `claude-fable-5-1[1m]`. */
const FAMILY_FIRST = /^claude-([a-z]+)((?:-\d{1,2})+)(?:-\d{8})?(?:\[[^\]]*\])?$/;
/** Claude 3.x put the version first: `claude-3-5-sonnet-20241022`. */
const VERSION_FIRST = /^claude-(\d{1,2}(?:-\d{1,2})*)-([a-z]+)(?:-\d{8})?(?:\[[^\]]*\])?$/;

/**
 * A model id as a reader says it: `claude-opus-5-5` → `Opus 5.5`. The date stamp and a `[1m]` suffix are dropped — the Context column already shows the
 * window. Anything that is not a Claude id of either shape (`''`, `<synthetic>`, a bare alias) comes back unchanged, so the cell never goes blank.
 */
export function modelLabel(id: string): string {
  const f = FAMILY_FIRST.exec(id);
  if (f) return `${title(f[1])} ${f[2].slice(1).replace(/-/g, '.')}`;
  const v = VERSION_FIRST.exec(id);
  if (v) return `${title(v[2])} ${v[1].replace(/-/g, '.')}`;
  return id;
}

function title(family: string): string {
  return family.charAt(0).toUpperCase() + family.slice(1);
}
