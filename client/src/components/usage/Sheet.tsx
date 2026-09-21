import type { ReactNode } from 'react';

import type { StatTile } from '../../lib/usageProfile';
import { InfoDot } from './ReadingAids';

/**
 * The Usage section's page chrome: the header band, the figure strip, and the
 * sheet a block of content sits on.
 *
 * Both tabs draw the same three, so they live here rather than twice. The
 * shapes are the design's, not this section's inventions — the band is §8.2's
 * ("the page header is a band, not a card"), and a sheet is §8.2's card:
 * `--strip` paper, 16px radius, no stroke and no shadow, with §7's title +
 * one-line subtitle pair at the top of it.
 *
 * The figure strip is the one new shape. It is a *single* card divided by the
 * ground rather than five cards with gaps, because the five figures are one
 * reading — "where the window stands, and whether to believe the rest of the
 * page" — and five separate cards would invite them to be read as five
 * unrelated facts.
 */

/** The page header: the title and one line under it. The switch between the
    section's two sub-views is the nav's tree, at every width — see `SideRail`. */
export function Band({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="usg-band">
      <div>
        <div className="usg-title">{title}</div>
        <div className="usg-sub">{sub}</div>
      </div>
    </div>
  );
}

/**
 * The figure strip.
 *
 * A tile whose `term` is set gets whatever `renderInfo` returns for it beside
 * the label — in practice the ⓘ for that term, quoting the same glossary the
 * definitions sheet at the foot of the page prints. The strip is handed the
 * glyph rather than building one, so it stays free of either tab's glossary.
 */
export function StatStrip({ tiles, renderInfo }: {
  tiles: StatTile[];
  renderInfo?: (term: string) => ReactNode;
}) {
  return (
    <div className="statstrip">
      {tiles.map(t => (
        <div key={t.key}>
          <div className="k">{t.label}{t.term && renderInfo?.(t.term)}</div>
          <div className={t.warn ? 'v warn' : 'v'}>
            {t.value}{t.unit !== undefined && <span className="u">{t.unit}</span>}
          </div>
          {t.sub !== '' && <div className="s">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** A block of the page: paper, 24px of padding, the sheets stacked 16px apart. */
export function Sheet({ children }: { children: ReactNode }) {
  return <section className="sheet">{children}</section>;
}

/**
 * A sheet's own heading row: title + subtitle on the left, an optional control
 * pushed to the right — the slot the design puts a filter chip in (§7).
 */
export function RowHead({ title, sub, sub2, right, info }: {
  title: ReactNode;
  sub?: ReactNode;
  /** Marks a *second* heading inside one sheet, which is set one step smaller. */
  sub2?: boolean;
  right?: ReactNode;
  info?: ReactNode;
}) {
  return (
    <div className="row-head">
      <div>
        <div className={sub2 ? 'ct sub' : 'ct'}>{title}{info}</div>
        {sub !== undefined && <div className="cs">{sub}</div>}
      </div>
      <span className="sp" />
      {right}
    </div>
  );
}

/** The 1px rule between two blocks inside one sheet. */
export function SheetDivider() {
  return <div className="sheet-div" />;
}

/**
 * The definitions sheet at the foot of each tab — printed from the same table
 * every ⓘ on the page quotes.
 *
 * A printed sheet rather than the closed `<details>` drawer it replaces: the
 * page is a disclosure view, and a reader who has just met six ⓘ glyphs is
 * exactly the reader who should not have to find a fold to read them all.
 */
export function Definitions({ terms }: {
  terms: readonly { key: string; term: string; text: string }[];
}) {
  return (
    <Sheet>
      <div className="ct">Definitions</div>
      <div className="cs">
        {terms.length} term{terms.length === 1 ? '' : 's'}, printed from the same table every
        ⓘ on this page quotes
      </div>
      <dl className="terms">
        {terms.map(g => (
          <div key={g.key}>
            <dt>{g.term}</dt>
            <dd>{g.text}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}

export { InfoDot };
