# lens.sirv.studio — design

The site is the record of one bug, kept like a certified transcript: numbered lines, speakers,
exhibits, redactions. The app keeps Sirv's sid-kit look; the site shares only its blue and icon.

## Tokens (site/public/assets/site.css, `:root`)

| Token | Light | Dark | Job |
| --- | --- | --- | --- |
| `--paper` | oklch(0.985 0.004 258) | oklch(0.17 0.018 262) | page ground |
| `--sheet` | oklch(1 0 0) | oklch(0.205 0.02 262) | the transcript sheet, download boxes |
| `--ink` / `--ink-soft` | 0.2 / 0.42 L | 0.95 / 0.77 L | text, secondary text |
| `--rule` / `--rule-strong` | hairlines | hairlines | section rules, sheet and shot edges |
| `--blue` | oklch(0.51 0.25 258) | oklch(0.53 0.22 259) | actions, exhibit stickers (white text ≥4.5:1) |
| `--blue-ink` | blue as text | blue as text | links, "You said", Q./A. |
| `--fail` | red | red | failures only (HTTP 500) |
| `--band*` | ink band | deeper ink | the one dark band: what an agent gets |
| `--bar` | near black | near white | redaction bars |
| `--line` | 1.75rem | | the line pitch; section spacing is a multiple of it |

## Type

- Libre Franklin (variable, self-hosted): headings 780–800 with -0.02em tracking, prose 400.
- Courier Prime (self-hosted): transcript lines, times, speakers, exhibit marks, code. Never for prose.

## Rules

- Paper or ink: no gray card fills and no soft shadows. Edges are 1px hairlines, radii 3–6px.
- Product screenshots are exhibits: a hairline frame and a blue sticker, `Exhibit A` to `E`.
- The visitor's system is the solid download box; the others are dashed.
- One motion: the hero lines type in once, in order. Reduced motion shows them at once.
- No eyebrows above headings; the Q./A. marks in Questions are the transcript's own form.

## Sources

- Screenshots: `node site/screenshots.mjs` (demo store, temp LENS_HOME, Claude stand-in).
- og.png: `node site/og.mjs`.
