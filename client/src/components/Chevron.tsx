/**
 * The one disclosure mark, copied from the account chip because the text triangles (▸ ▾ ▴) were too small to see.
 * Colour comes from `currentColor`, so the wrapper decides it; `dir` turns the same path rather than drawing three glyphs.
 */
export default function Chevron({ dir = 'down', className }: { dir?: 'down' | 'up' | 'right'; className?: string }) {
  return (
    <svg className={`chev chev-${dir}${className ? ' ' + className : ''}`} viewBox="0 0 10 10" aria-hidden="true"><path d="M2 4l3 3 3-3" /></svg>
  );
}
