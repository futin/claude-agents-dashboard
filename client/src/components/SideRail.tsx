import { useEffect, useState } from 'react';

import { SECTIONS, type Section } from '../lib/sections';
import { useBackClose } from '../hooks/useBackClose';
import { useHideOnScroll } from '../hooks/useHideOnScroll';
import { useManagementScope } from '../hooks/useManagementScope';
import { useSettings } from '../hooks/useSettings';
import type { Settings } from '../lib/settings';

interface Props {
  section: Section;
  onChange: (s: Section) => void;
}

/**
 * Top-level section switch: live sessions monitor · config management ·
 * session analytics · account usage forecast · settings. A rail down the left edge on desktop; below
 * 700px the same rail becomes a menu panel that drops out of a top bar —
 * wordmark left, ☰ right — see docs/superpowers/specs/2026-08-15-side-rail-nav-design.md.
 *
 * The phone menu is the *same* markup as the rail, not a second navigation:
 * one `.rail` element, repositioned. That is what lets the trees come with it —
 * a vertical panel can draw the tree a horizontal strip could not, so the
 * page-band copies of those switches (`.usg-tabs`, `.set-tabs`,
 * `.mgmt-scopesel`) are gone and the menu is the one control at every width.
 *
 * Every tree is rendered, always; which of them are *shown* is one CSS rule.
 * In the phone menu they all stand open, so one tap reaches any sub-view from
 * anywhere. On the rail only the open section's tree is drawn — a tree hanging
 * off a row you are not on is a second depth to read past on every glance, and
 * a rail is on screen the whole time where the menu is a moment. The open
 * section's group carries `.here`, which is all the rule keys off.
 *
 * A tree never shows a selection for a section you are not in, and every row —
 * main or sub — is a destination: a main row enters its section on the *first*
 * sub-view, a sub row enters it on the one it names. So nothing is chosen
 * before you arrive, and no row is inert.
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
 * The sections whose sub-views are a *fixed* list, and the per-device setting
 * each tree writes: Usage (Forecast / Token value) and Settings (Local /
 * Shared), drawn from one table so a third gets the same tree for one line.
 * Management's tree is the third destination but not a fixed list — its rows
 * are the scanned projects — so it has its own component below.
 */
type SubKey = 'usageTab' | 'settingsTab';
interface SubNav<K extends SubKey> { key: K; items: { value: Settings[K]; label: string }[] }
const SUBNAV: Partial<Record<Section, SubNav<'usageTab'> | SubNav<'settingsTab'>>> = {
  usage: { key: 'usageTab', items: [{ value: 'forecast', label: 'Forecast' }, { value: 'rates', label: 'Token value' }] },
  settings: { key: 'settingsTab', items: [{ value: 'local', label: 'Local' }, { value: 'shared', label: 'Shared' }] }
};

/**
 * Management's sub-nav: Global + every recently-active project (DESIGN.md
 * §8.5). Unlike Usage and Settings this tree is *data* — its rows come from
 * `GET /api/management`, shared with the page through `ManagementScopeProvider`
 * so the index is fetched exactly once. Mounted from the first paint now that
 * the phone menu opens every tree, which is why the provider scans on load
 * rather than on entering the section.
 */
function ManagementSubNav({ active, pick, enter }: {
  /** Management is the open section — a sub-row only reads as chosen there. */
  active: boolean;
  pick: (fn: () => void) => () => void;
  /** Picking a project is also a way *into* Management, from any section. */
  enter: (fn: () => void) => void;
}) {
  const { projects, scope, setScope } = useManagementScope();
  const rows = [
    { id: 'global', name: 'Global', path: '~/.claude' },
    ...projects.map(p => ({ id: p.dirName, name: p.name, path: p.path }))
  ];

  return (
    <div className="rail-sub">
      {rows.map(r => {
        const on = active && scope === r.id;
        return (
          <button
            key={r.id}
            className={on ? 'rail-sublink on' : 'rail-sublink'}
            aria-current={on ? 'true' : undefined}
            /* the rail carries the label; the band is where the path is spelled
               out, so here it is only the hover hint for a truncated name */
            title={r.path}
            onClick={pick(() => enter(() => setScope(r.id)))}
          >
            {r.name}
          </button>
        );
      })}
    </div>
  );
}

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

/**
 * The app's only wordmark — the sessions page deliberately has no <h1>. The
 * mock's own shape: the dot outside the two-line text block and centred against
 * it. No <br> — the kicker is a block, and a break after it opened a second,
 * empty line that pushed the name away.
 *
 * Rendered once per breakpoint, never twice at once: the rail's copy is hidden
 * below 700px and the top bar's above it, so there is exactly one <h1>.
 */
function Brand({ className }: { className: string }) {
  return (
    <h1 className={className}>
      <span className="rail-dot" aria-hidden="true" />
      <span>
        <span className="rail-kicker">Claude</span>
        Dashboard
      </span>
    </h1>
  );
}

/** ☰ when the menu is shut, × when it is down. 1.5px strokes, like the row icons. */
function BurgerIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="rail-ic"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      {open
        ? <path d="M5 5l10 10M15 5L5 15" />
        : <path d="M3 5.5h14M3 10h14M3 14.5h14" />}
    </svg>
  );
}

/**
 * Mounted only while the phone menu is down: the scrim, plus the two ways out
 * that are not a tap on it. `useBackClose` is the chat drawer's — on a phone
 * the back swipe is what a full-width panel is expected to answer, and it must
 * not leave the board behind.
 */
function MenuLayer({ onClose }: { onClose: () => void }) {
  useBackClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="mnav-scrim" onClick={onClose} />;
}

export function SideRail({ section, onChange }: Props) {
  // A section's sub-views are navigation, so they live in the nav: this is the
  // only control for them at every width, and the section renders whichever is
  // chosen. Per-device, like every other setting.
  const { settings, update } = useSettings();
  // Management's tree writes the shared scope, and entering Management from its
  // main row resets that scope the same way the fixed trees reset their tab.
  const { setScope } = useManagementScope();
  // Phone only — the bar and the burger are `display:none` above 700px, so on a
  // desktop this stays false and nothing here has any effect on the rail.
  const [open, setOpen] = useState(false);
  // The bar gets out of the way going down the page and comes back on the way
  // up. Pinned open while the menu is down: the panel hangs off the bar.
  const barOff = useHideOnScroll(open);

  // Picking anything is a destination, so the menu closes behind it. The rail
  // above 700px is never open, so this is a no-op there.
  const pick = (fn: () => void) => (): void => { fn(); setOpen(false); };

  /**
   * Entering a section from the nav, which is the *only* thing a row here does.
   * A main row lands on that section's first sub-view; a sub row lands on the
   * one it names (`choose`). Both switch the section first — before this, a
   * sub-row was a write to a setting belonging to a page you were not on, so
   * tapping one from another section looked like a dead control.
   *
   * The reset on a main row is why no tree shows a selection until you are in
   * its section: the choice is made on arrival, not remembered from last time.
   */
  const enter = (id: Section, choose?: () => void): void => {
    onChange(id);
    if (choose) { choose(); return; }
    const sub = SUBNAV[id];
    if (sub) update({ [sub.key]: sub.items[0].value } as Partial<Settings>);
    if (id === 'management') setScope('global');
  };

  return (
    /* `display:contents` above 700px: the rail itself stays the flex child of
       `.shell` it has always been. Below it, this is the sticky box the bar
       sits in and the menu drops out of. */
    <div className={barOff ? 'nav hid' : 'nav'}>
      <div className="mnav">
        <Brand className="mnav-brand" />
        <button
          className="mnav-burger"
          aria-expanded={open}
          aria-controls="rail-nav"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen(v => !v)}
        >
          <BurgerIcon open={open} />
        </button>
      </div>
      {open && <MenuLayer onClose={() => setOpen(false)} />}
      <nav id="rail-nav" className={open ? 'rail open' : 'rail'} aria-label="Sections">
        <Brand className="rail-brand" />
        {SECTIONS.map(t => (
          <div key={t.id} className={section === t.id ? 'rail-group here' : 'rail-group'}>
            {/* Settings is the one section that is about the board rather than
                about the work, so it sits under a rule like the mock's. */}
            {t.id === 'settings' && <div className="rail-div" />}
            <button
              className={section === t.id ? 'rail-link on' : 'rail-link'}
              aria-current={section === t.id ? 'page' : undefined}
              onClick={pick(() => enter(t.id))}
            >
              <Icon section={t.id} />
              {t.label}
            </button>
            {t.id === 'management' && (
              <ManagementSubNav
                active={section === 'management'}
                pick={pick}
                enter={fn => enter('management', fn)}
              />
            )}
            {SUBNAV[t.id] && (
              <div className="rail-sub">
                {SUBNAV[t.id]!.items.map(s => {
                  const sub = SUBNAV[t.id]!;
                  // Gated on the open section: a tree belonging to a section
                  // you are not in names no current view, so it marks none.
                  const on = section === t.id && settings[sub.key] === s.value;
                  return (
                    <button
                      key={s.value}
                      className={on ? 'rail-sublink on' : 'rail-sublink'}
                      aria-current={on ? 'true' : undefined}
                      /* the computed key loses the per-key value type; the table
                         above is what guarantees `s.value` fits `sub.key` */
                      onClick={pick(() => enter(t.id, () => update({ [sub.key]: s.value } as Partial<Settings>)))}
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
    </div>
  );
}
