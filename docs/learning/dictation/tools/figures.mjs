/**
 * figures.mjs — hand-authored SVG standing in for the guide's mermaid fences.
 *
 * The page is self-contained and offline-safe, so it cannot load mermaid.js to
 * draw the ```mermaid blocks. Each fence is replaced by the figure keyed
 * `<doc-slug>:<ordinal>` below, in the order the fences appear in that file.
 *
 * Every colour is a CSS custom property inherited from the page. Never a hex
 * literal in here — a `stroke="#333"` diagram is invisible in dark mode and you
 * will not notice, because you authored it in light mode.
 */

const DEFS = `
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--line)"/>
      </marker>
    </defs>`;

/** A rounded box with one or two centred lines of monospace label. */
function box(x, y, w, h, lines) {
  const cx = x + w / 2;
  const ys = lines.length === 1
    ? [y + h / 2 + 5]
    : [y + h / 2 - 4, y + h / 2 + 13];
  const text = lines
    .map((l, i) => `<text x="${cx}" y="${ys[i]}">${l}</text>`)
    .join('\n        ');
  return `      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>
      <g class="boxlabel">
        ${text}
      </g>`;
}

const FIGURES = {
  // ── The whole pipeline, wrapped over two rows ──────────────────────────────
  'readme:0': {
    caption: 'One request in, one string out — no queue, no job id, no progress stream.',
    title: 'Tap the mic, record a blob, POST it, transcode to WAV, transcribe, parse, append to the textarea',
    svg: `<svg viewBox="0 0 884 286" role="img" xmlns="http://www.w3.org/2000/svg">
    <title>Tap the mic, record a blob, POST it, transcode to WAV, transcribe, parse, append to the textarea</title>${DEFS}
    <g stroke="var(--line)" stroke-width="1.5" fill="var(--panel)">
${box(12, 48, 170, 56, ['MicButton', 'render gate'])}
${box(242, 48, 170, 56, ['useDictation', 'MediaRecorder'])}
${box(472, 48, 170, 56, ['POST', '/api/transcribe'])}
${box(702, 48, 170, 56, ['transcribe()', 'mkdtemp'])}
${box(12, 200, 170, 56, ['ffmpeg', '16kHz mono'])}
${box(242, 200, 170, 56, ['whisper-cli', '-nt'])}
${box(472, 200, 170, 56, ['parseOutput'])}
${box(702, 200, 170, 56, ['textarea', 'appendTranscript'])}
    </g>

    <g stroke="var(--line)" stroke-width="1.5" fill="none" marker-end="url(#arrow)">
      <line x1="182" y1="76" x2="238" y2="76"/>
      <line x1="412" y1="76" x2="468" y2="76"/>
      <line x1="642" y1="76" x2="698" y2="76"/>
      <path d="M 787 104 V 138 Q 787 152 773 152 H 111 Q 97 152 97 166 V 196"
            stroke="var(--accent)"/>
      <line x1="182" y1="228" x2="238" y2="228"/>
      <line x1="412" y1="228" x2="468" y2="228"/>
      <line x1="642" y1="228" x2="698" y2="228"/>
    </g>

    <g fill="var(--muted)" font-size="11" text-anchor="middle">
      <text x="210" y="68">tap</text>
      <text x="440" y="68">Blob</text>
      <text x="670" y="68">bytes</text>
      <text x="442" y="146">clip.m4a</text>
      <text x="210" y="220">clip.wav</text>
      <text x="440" y="220">stdout</text>
      <text x="670" y="220">text</text>
    </g>
  </svg>`
  },

  // ── The three-way render gate ──────────────────────────────────────────────
  'render-gate:0': {
    caption: 'Three outcomes before any audio exists — the middle one is the deliberate part.',
    title: 'The availability probe resolves to hidden, disabled, or a live mic with three phases',
    svg: `<svg viewBox="0 0 780 344" role="img" xmlns="http://www.w3.org/2000/svg">
    <title>The availability probe resolves to hidden, disabled, or a live mic with three phases</title>${DEFS}
    <g stroke="var(--line)" stroke-width="1.5" fill="var(--panel)">
${box(12, 140, 140, 54, ['probe'])}
${box(230, 24, 170, 48, ['render nothing'])}
${box(230, 140, 170, 48, ['disabled button'])}
${box(230, 256, 170, 48, ['live mic'])}
${box(470, 190, 150, 44, ['recording'])}
${box(470, 262, 150, 44, ['transcribing'])}
    </g>

    <g stroke="var(--line)" stroke-width="1.5" fill="none" marker-end="url(#arrow)">
      <path d="M 152 158 C 190 158 190 48 224 48"/>
      <line x1="152" y1="164" x2="224" y2="164"/>
      <path d="M 152 176 C 190 176 190 280 224 280" stroke="var(--accent)"/>
      <path d="M 400 268 C 436 268 436 212 464 212"/>
      <line x1="545" y1="234" x2="545" y2="258"/>
      <path d="M 468 290 C 440 296 434 292 406 288"/>
    </g>

    <g fill="var(--muted)" font-size="11" text-anchor="middle">
      <text x="315" y="16">transcribe = false</text>
      <text x="315" y="132">insecure context</text>
      <text x="315" y="248">engine + HTTPS</text>
      <text x="432" y="196">tap</text>
      <text x="436" y="326">text or error</text>
    </g>
    <g fill="var(--muted)" font-size="11" text-anchor="start">
      <text x="553" y="252">tap / 120s cap</text>
    </g>
  </svg>`
  },

  // ── The hook's own phase machine ───────────────────────────────────────────
  'recorder-lifecycle:0': {
    caption: 'Two of the four transitions out of `requesting` are failure paths — one of them has no user in it.',
    title: 'idle to requesting to recording to transcribing, with a rejection path and an unmount exit',
    svg: `<svg viewBox="0 0 820 300" role="img" xmlns="http://www.w3.org/2000/svg">
    <title>idle to requesting to recording to transcribing, with a rejection path and an unmount exit</title>${DEFS}
    <circle cx="24" cy="111" r="7" fill="var(--fg)"/>
    <circle cx="302" cy="36" r="10" fill="none" stroke="var(--muted)" stroke-width="1.5"/>
    <circle cx="302" cy="36" r="5" fill="var(--muted)"/>

    <g stroke="var(--line)" stroke-width="1.5" fill="var(--panel)">
${box(52, 88, 130, 46, ['idle'])}
${box(232, 88, 140, 46, ['requesting'])}
${box(422, 88, 140, 46, ['recording'])}
${box(612, 88, 150, 46, ['transcribing'])}
    </g>

    <g stroke="var(--line)" stroke-width="1.5" fill="none" marker-end="url(#arrow)">
      <line x1="33" y1="111" x2="48" y2="111"/>
      <line x1="182" y1="111" x2="228" y2="111"/>
      <line x1="372" y1="111" x2="418" y2="111"/>
      <line x1="562" y1="111" x2="608" y2="111"/>
      <path d="M 290 136 C 262 182 162 182 132 138"/>
      <path d="M 302 86 V 50" stroke="var(--accent)"/>
      <path d="M 687 136 C 687 250 104 262 104 140"/>
    </g>

    <g fill="var(--muted)" font-size="11" text-anchor="middle">
      <text x="205" y="102">toggle()</text>
      <text x="395" y="102">resolved</text>
      <text x="585" y="102">onstop</text>
      <text x="211" y="188">rejected</text>
      <text x="400" y="258">text or error</text>
    </g>
    <g fill="var(--muted)" font-size="11" text-anchor="start">
      <text x="318" y="40">unmounted mid-prompt</text>
    </g>
  </svg>`
  },

  // ── The onstop cascade ─────────────────────────────────────────────────────
  'recorder-lifecycle:1': {
    caption: 'The cleanup is what fires `onstop` — the guard exists so the correct behaviour is survivable.',
    title: 'Unmounting stops the tracks, which makes the stream inactive, which stops the recorder and fires stop',
    svg: `<svg viewBox="0 0 780 344" role="img" xmlns="http://www.w3.org/2000/svg">
    <title>Unmounting stops the tracks, which makes the stream inactive, which stops the recorder and fires stop</title>${DEFS}
    <g stroke="var(--line)" stroke-width="1.5" fill="var(--panel)">
${box(15, 12, 150, 40, ['MessagePanel'])}
${box(205, 12, 150, 40, ['useDictation'])}
${box(395, 12, 150, 40, ['MediaStream'])}
${box(585, 12, 150, 40, ['MediaRecorder'])}
    </g>

    <g stroke="var(--line)" stroke-width="1" stroke-dasharray="4 4">
      <line x1="90" y1="52" x2="90" y2="322"/>
      <line x1="280" y1="52" x2="280" y2="322"/>
      <line x1="470" y1="52" x2="470" y2="322"/>
      <line x1="660" y1="52" x2="660" y2="322"/>
    </g>

    <g stroke="var(--line)" stroke-width="1.5" fill="none" marker-end="url(#arrow)">
      <line x1="90" y1="90" x2="276" y2="90"/>
      <path d="M 280 120 H 322 V 140 H 288"/>
      <line x1="280" y1="175" x2="466" y2="175" stroke="var(--accent)"/>
      <path d="M 280 278 H 322 V 298 H 288"/>
    </g>
    <g stroke="var(--line)" stroke-width="1.5" fill="none" stroke-dasharray="5 4"
       marker-end="url(#arrow)">
      <line x1="470" y1="210" x2="656" y2="210"/>
      <line x1="660" y1="245" x2="284" y2="245"/>
    </g>

    <g fill="var(--muted)" font-size="11" text-anchor="middle">
      <text x="185" y="82">unmount, idle sweep</text>
      <text x="375" y="167">stopTracks()</text>
      <text x="565" y="202">stream inactive</text>
      <text x="470" y="237">fires stop</text>
    </g>
    <g fill="var(--muted)" font-size="11" text-anchor="start">
      <text x="330" y="128">liveRef = false</text>
      <text x="330" y="286">upload() sees false, returns</text>
    </g>
  </svg>`
  }
};

export function figureFor(docSlug, ordinal) {
  return FIGURES[`${docSlug}:${ordinal}`] ?? null;
}

export const FIGURE_KEYS = Object.keys(FIGURES);
