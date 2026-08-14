# ATC flight-strip reskin — design

**Date:** 2026-08-14
**Scope:** whole-dashboard visual reskin (Sessions, Management, Analytics, chat drawer).
**Approach:** strip anatomy on the current IA — materials change, structure/labels/behavior do not.

## Concept

The dashboard's job is one human monitoring many concurrent autonomous agents. The
real-world tool built for exactly that job is the air-traffic-control **flight-progress
strip board**: paper strips in colored holders, racked in a dark room, tilted ("cocked")
when one needs the controller's action. Every visual decision below derives from that
artifact. The metaphor stops at materials — no section renames, no regrouping, no
behavior changes.

**Tone:** dark board, paper strips — the room stays dark (warm painted-steel charcoal,
not void-black); each session strip reads as a lit physical object.

## 1. Tokens

### Palette

| Token | Hex | Role |
|---|---|---|
| `--board` | `#141410` | page background — painted-steel bay, olive cast |
| `--steel` | `#1c1b14` | recessed wells: inputs, bar tracks, inactive controls, code bg |
| `--strip` | `#252317` | strip paper — every card/row surface; 1px top edge-light (`rgba(255,255,255,.05)`) so it reads physical |
| `--ink` | `#eae4cf` | primary text |
| `--ink2` | `#a8a189` | secondary text |
| `--ink3` | `#7d7660` | captions/faint (bumped from a darker candidate for contrast) |
| `--green` | `#54c168` | working: holder edge, stamp, pulse |
| `--amber` | `#ffa51e` | **attention only**: question holder, cocked strip, ANSWER stamp, QuestionPanel, review-due chip |
| `--mustard` | `#c9b34a` | incomplete/pending holder + stamp |
| `--cyan` | `#53c7cf` | the single interactive accent: selection, links, focus rings, active tab, user messages. Replaces today's blue everywhere |
| `--red` | `#e0533f` | danger thresholds (context %, usage bars) |
| `--magenta` | `#cf6f9e` | Task/subagent + kaizen markers (kept from current pink, muted to sit on paper) |

Rules: amber is never decorative — it always means "a human must act". One cool accent
(cyan) carries all interactivity so status colors stay unambiguous.

### Type

Self-hosted via `@fontsource` packages — **client-only** deps; server stays zero-dep;
no CDN (tailnet/offline unaffected).

| Face | Weights | Role |
|---|---|---|
| **Barlow Condensed** | 600, 700 | display: plate header, tab labels, status stamps, bay/field micro-labels. Uppercase, letterspaced |
| **Barlow** | 400, 600 | body/UI text |
| **IBM Plex Mono** | 400, 600 | all data: token counts, %, branch, model, clock, timestamps, code, IDs. Tabular numerals |

Scale stays dense (existing 10–14px range); display sizes 16–18px.

## 2. The strip (session row)

- Square geometry: `border-radius: 2px` (chamfer, not today's 10px rounds).
- **Holder edge:** 7px solid left edge, color = status — working green, pending mustard,
  question amber, idle steel. This replaces the current tinted full borders.
- Paper body: `--strip` bg, 1px top edge-light, soft drop shadow.
- Field pills (proj/branch/model) become **printed boxes**: 1px hairline border, no fill,
  Plex Mono, square corners.
- Context bar → flat **printed gauge**: single color by threshold (green → amber → red),
  on a `--steel` track. The current green→blue gradient is deleted.
- Status word → condensed-caps **stamp** (`WORKING` / `PENDING` / `IDLE` — labels
  unchanged, only typography).
- Hover: strip lifts 1px + edge lightens. Selected: cyan hairline border.

### Signature — the cocked strip

A `question`-status strip is **cocked**: `transform: rotate(-0.55deg) translateX(6px)`,
amber holder edge, elevated shadow, pulsing amber `ANSWER` stamp (the existing answer
pill, re-dressed). It stays cocked until answered. Nothing else on the page ever tilts.
This is the one aesthetic risk; everything around it stays quiet.

## 3. Chrome

- **Header → facility plate:** `CLAUDE SESSIONS` in Barlow Condensed 700 caps; the
  counts line as a stamped mono sub-plate; clock in a boxed mono readout, right-aligned.
- **Usage bars → twin gauges** labeled `5H` / `WEEK`: flat threshold fills, mono %.
- **Tabs → rack selector:** square, condensed caps; active = paper-raised + 2px cyan bar.
- **Toolbar:** selects/buttons as recessed steel wells, square, mono labels. Origin and
  phone-answers pills → square badges, same dot semantics.

## 4. Drawer + question panel

- Drawer keeps slide-in and all structure; materials swap to board/strip/steel.
- User messages: cyan left rule + faint paper tint. Assistant: plain ink. Tool lines mono.
- Filter row `ALL` / `TEXT` / `YOU` → condensed stamp buttons.
- **QuestionPanel goes amber** (it is where a cocked strip gets answered): amber hairline
  top, amber badge, options as square paper buttons. Phone thumb-target sizes kept as-is.

## 5. Management + Analytics

Inherit via the same classes with new values:

- Cards/items → lighter strips: no holder edge; cyan hairline when selected.
- Group headers → condensed bay labels.
- File viewer: mono on `--steel`, unchanged behavior.
- Analytics metric values: large Plex Mono numerals (logbook feel). Status badges →
  stamps: `ACTIONED` green, `PROMOTED` cyan, `OPEN` hollow. Review-due chip amber.

## 6. Motion

- Keep: working dot pulse (green), answer pulse (amber), drawer slide.
- New: **slot-in** — a newly mounted strip drops into the rack (`translateY(-3px)→0` +
  fade, .18s). Mount-only; reorders of existing keys don't fire it.
- `prefers-reduced-motion: reduce`: all pulses + slot-in disabled. The static cock stays
  (posture, not motion).

## 7. Quality floor

- Focus: 2px cyan outline (offset) on every interactive element.
- Contrast: ink on strip ≈ 10:1; amber stamp on strip ≈ 7:1; `--ink3` chosen ≥ ~4:1 for
  captions.
- Existing breakpoints (700px / 1000px) and mobile question-flow layout kept.
- Class names stay stable (project convention: styling holds because names hold).

## 8. Implementation scope

- Rewrite `client/src/styles.css` **values** — class names preserved.
- Tiny markup additions only where the design needs a hook (stamp/micro-label spans).
- `client/package.json`: add `@fontsource/barlow`, `@fontsource/barlow-condensed`,
  `@fontsource/ibm-plex-mono`; import weights in `client/src/main.tsx`.
- No server changes. No IA, label, or behavior changes. No new client logic.

## Self-check against AI-default looks

- Not cream + serif + terracotta (dark board).
- Not void-black + single acid accent: warm olive-charcoal, material palette with
  role-separated status colors.
- Hairline/square language is the printed strip form's own geometry — kept physical with
  edge-light and shadows, which the "broadsheet" default forbids.
- Boldness concentrated in exactly one place: the cocked strip.
