import { useEffect, useState } from 'react';

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
 * tapped — a same-origin iframe viewer. `.guide-viewer-head` is kept as its
 * own element deliberately: it's the exact class name a later Ask-Claude
 * companion panel (on-hold spec) mounts into, so its shape must stay stable.
 */
export default function GuidesView() {
  const { index, loading, error } = useGuides();
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const viewing = viewer !== null;

  /*
    Phone only in effect (the CSS rule lives inside the max-width:700px
    breakpoint), but the class goes on unconditionally: the viewer is an
    overlay at that width, and the deck it frames scrolls inside an iframe.
    A scroller in another document can't be given `overscroll-behavior`
    from here the way .chat-body gives itself one, so the chain is refused
    at the root instead — see the .guide-locked rule in styles.css. Must sit
    above the early return below: hooks don't get to be conditional.
  */
  useEffect(() => {
    if (!viewing) return;
    const root = document.documentElement;
    root.classList.add('guide-locked');
    return () => root.classList.remove('guide-locked');
  }, [viewing]);

  if (viewer !== null) {
    return (
      <div className="guide-viewer">
        <div className="guide-viewer-head">
          <button className="guide-viewer-back" onClick={() => setViewer(null)}>‹ Guides</button>
          <span className="guide-viewer-title">{viewer.title}</span>
        </div>
        <div className="guide-viewer-body">
          {/*
            No `sandbox` attribute: this iframe is same-origin — our own
            server, serving our own generated HTML from
            docs/published-guides/, on purpose. The deck's inline <script>
            is what makes it work at all: every `.card` starts
            `display:none` and only `.card.active` shows one, so Back/Next,
            the arrow-key shortcuts, and the quiz's click-to-reveal feedback
            are entirely script-driven — block scripts and the deck freezes
            on its first card forever. (The "Questions you might ask"
            <details> cards are native disclosure and don't need scripting;
            it's the pager and the quiz that do.) There is no untrusted
            content here to isolate, so don't add a `sandbox` back without
            re-testing the pager and the quiz against it.
          */}
          <iframe
            className="guide-viewer-frame"
            src={`/guides/${encodeURI(viewer.relPath)}`}
            title={viewer.title}
          />
        </div>
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
