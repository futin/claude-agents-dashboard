import { useState } from 'react';

import type { DeckRef, GuideRef } from '../../../../shared/types';
import { useGuides } from '../../hooks/useGuides';

/** What the viewer pane shows; null means the list is shown instead. */
interface ViewerState {
  relPath: string;
  title: string;
}

/**
 * Guides section — tutor decks and study guides published under
 * docs/published-guides/, read via GET /api/guides (server/lib/guides.ts).
 * Read-only and unpolled: guides change on the order of days, not seconds.
 * Default export → lazy chunk, matching Management/Analytics/Settings.
 *
 * Two states: a card list (Decks, then Study guides), or — once a card is
 * tapped — a viewer pane. The iframe itself is Task 6's; this component only
 * lays out the header (`.guide-viewer-head`, the exact class name a later
 * Ask-Claude companion mounts into) and an empty body for it to fill.
 */
export default function GuidesView() {
  const { index, loading, error } = useGuides();
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  if (viewer !== null) {
    return (
      <div className="guide-viewer">
        <div className="guide-viewer-head">
          <button className="guide-viewer-back" onClick={() => setViewer(null)}>‹ Guides</button>
          <span className="guide-viewer-title">{viewer.title}</span>
        </div>
        <div className="guide-viewer-body" />
      </div>
    );
  }

  const decks = index?.decks ?? [];
  const guides = index?.guides ?? [];

  return (
    <div className="guides">
      <div className="guides-bar">
        <div className="guides-title">Guides</div>
      </div>

      {loading ? (
        <div className="guides-empty">loading…</div>
      ) : error ? (
        <div className="guides-empty">guides unavailable</div>
      ) : decks.length === 0 && guides.length === 0 ? (
        <div className="guides-empty">nothing published yet</div>
      ) : (
        <>
          {decks.length > 0 && (
            <div className="guides-group">
              <div className="guides-group-h">Decks</div>
              <div className="guides-list">
                {decks.map(d => (
                  <DeckCard
                    key={d.relPath}
                    deck={d}
                    onOpen={() => setViewer({ relPath: d.relPath, title: d.title })}
                  />
                ))}
              </div>
            </div>
          )}
          {guides.length > 0 && (
            <div className="guides-group">
              <div className="guides-group-h">Study guides</div>
              <div className="guides-list">
                {guides.map(g => (
                  <GuideCard
                    key={g.relPath}
                    guide={g}
                    onOpen={() => setViewer({ relPath: `${g.relPath}/index.html`, title: g.title ?? g.name })}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One tappable deck card: title, section count, generated date, short commit — each omitted when absent. */
function DeckCard({ deck, onOpen }: { deck: DeckRef; onOpen: () => void }) {
  const meta: string[] = [];
  if (deck.sections !== null) meta.push(`${deck.sections.length} sections`);
  if (deck.generated !== null) meta.push(deck.generated);
  if (deck.commit !== null) meta.push(deck.commit.slice(0, 7));

  return (
    <div className="guides-card" role="button" onClick={onOpen}>
      <div className="guides-card-title">{deck.title}</div>
      {meta.length > 0 && <div className="guides-card-meta">{meta.join(' · ')}</div>}
    </div>
  );
}

/** One tappable guide card: title, falling back to the file's basename when the guide has no `<title>`. */
function GuideCard({ guide, onOpen }: { guide: GuideRef; onOpen: () => void }) {
  return (
    <div className="guides-card" role="button" onClick={onOpen}>
      <div className="guides-card-title">{guide.title ?? guide.name}</div>
    </div>
  );
}
