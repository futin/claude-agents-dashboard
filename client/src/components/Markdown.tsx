import { useMemo } from 'react';

import { listTree, parseMarkdown, type Block, type Inline, type ListNode } from '../lib/markdown';

/** Inline spans → elements. Recursive for strong/em/link children. */
function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((s, i) => {
        switch (s.t) {
          case 'text': return <span key={i}>{s.v}</span>;
          case 'code': return <code key={i} className="md-code">{s.v}</code>;
          case 'strong': return <strong key={i}><Spans spans={s.kids} /></strong>;
          case 'em': return <em key={i}><Spans spans={s.kids} /></em>;
          case 'link':
            return (
              <a key={i} className="md-link" href={s.href} target="_blank" rel="noreferrer noopener">
                <Spans spans={s.kids} />
              </a>
            );
          case 'path':
            return (
              <span key={i} className="md-path" title={s.target}>
                <Spans spans={s.kids} />
              </span>
            );
        }
      })}
    </>
  );
}

/** One list of a list tree, each child list inside its parent item — nesting gives the indent, and `start` keeps the written numbers (#519). */
function ListView({ node }: { node: ListNode }) {
  const items = node.items.map((it, i) => (
    <li key={i}>
      <Spans spans={it.spans} />
      {it.children.map((c, j) => <ListView key={j} node={c} />)}
    </li>
  ));
  return node.ordered
    ? <ol className="md-list" start={node.start ?? undefined}>{items}</ol>
    : <ul className="md-list">{items}</ul>;
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case 'p':
      return <p className="md-p"><Spans spans={b.spans} /></p>;
    case 'h':
      return <div className={`md-h md-h${Math.min(b.level, 4)}`}><Spans spans={b.spans} /></div>;
    case 'code':
      // Wide code scrolls inside its own box — the drawer never scrolls sideways.
      return <pre className="md-pre"><code>{b.text}</code></pre>;
    case 'hr':
      return <div className="md-hr" />;
    case 'quote':
      return <blockquote className="md-quote"><Spans spans={b.spans} /></blockquote>;
    case 'list':
      return <ListView node={listTree(b.items)} />;
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{b.head.map((c, i) => (
                <th key={i} style={{ textAlign: b.align[i] === 'c' ? 'center' : b.align[i] === 'r' ? 'right' : 'left' }}>
                  <Spans spans={c} />
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>{row.map((c, i) => (
                  <td key={i} style={{ textAlign: b.align[i] === 'c' ? 'center' : b.align[i] === 'r' ? 'right' : 'left' }}>
                    <Spans spans={c} />
                  </td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Render a markdown subset (see lib/markdown.ts) as elements — no raw HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="md">{blocks.map((b, i) => <BlockView key={i} b={b} />)}</div>;
}
