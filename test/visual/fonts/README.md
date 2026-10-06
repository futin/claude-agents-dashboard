# Vendored Hanken Grotesk

The UI face (`--font`, `client/src/styles.css`), served to the visual suite by `test/visual/mock-api.ts` so no run depends on the network or can capture the
fallback face.

- **Source:** `https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap` — the exact URL in `client/index.html` — fetched
  with a Chrome 153 macOS user agent so it serves woff2, plus every `fonts.gstatic.com` file that CSS references (`v12`, one variable file per unicode subset;
  all four weights share it).
- **Fetched:** 2026-10-06.
- **Licence:** SIL Open Font License 1.1 (Hanken Grotesk, Hanken Design Co.).
- **Layout:** `hanken-grotesk.css` is stored verbatim; `mock-api` answers `fonts.googleapis.com/css2*` with it and each `fonts.gstatic.com/…/<file>.woff2`
  with the file of the same basename here. A requested font file with no copy here is an off-origin failure.

Re-fetching changes rasterised glyphs, so it re-baselines every shot.
