# Changelog

## v0.0.8 — 2026-07-19

- **Full-screen demo mode**: entering demo hides the entire editor chrome —
  the design is the screen. A floating pill bar at the bottom carries
  ← / ■ Stop / → : the arrows step the camera between windows (also
  Ctrl+← / Ctrl+→), Stop (or Esc) returns to edit mode. Entering demo
  auto-frames the main (largest visible) window; secondary windows are
  reached through flow connections or the arrows.
- **Demo scrolling fixed**: any visible scroll container with overflowing
  content now scrolls under the wheel — `interactionEnabled: false` no
  longer blocks it, and a nested non-scrollable section no longer swallows
  the wheel (which used to fall through to canvas zoom).
- **Demo-testing commands** for the command bar / `pixelruller-command`,
  so an AI can exercise a design's behavior and verify it: `click <el>`
  (fire the interaction exactly like a demo click), `show <el>` /
  `hide <el>` (runtime visibility), `focus <window>` (frame a window),
  `scroll <container> <y> [x]` (set offsets; reports clamped position and
  maxima).
- **Ctrl+Click copies "name (id)"** of the element to the clipboard with a
  "Copied: …" toast, alongside opening its properties — a reliable
  replacement for the 5-second hover-copy.
- **Skill/AI guide**: new non-negotiable rule — modals, dialogs, and
  floating windows are placed NEXT TO their window on the canvas, never on
  top of the design, so everything stays inspectable in edit mode; demo
  mode shows the real overlay behavior. Demo-testing verbs documented and
  `pixelruller.skill` rebuilt.

## v0.0.7 — 2026-07-19

- **Modal sections**: `set <section> modal true` floats a section above its
  whole window on a dark scrim — hamburger menus and gear/settings dialogs in
  the same window's JSON instead of a fake second window. `anchor <element>`
  pins it under its trigger; without an anchor it centres. Round-trips through
  the design JSON, hit-tests above everything while open, and dismisses by
  clicking outside.
- **Demo mode** (▶ Demo button / `demo on|off|toggle`): use the design like a
  running app — plain clicks fire `action`/`target` interactions, controls flip
  their own state (toggle `on`, checkbox `checked`, radio with sibling-group
  clearing, slider `value` from the click position, tabs switch), wheel scrolls
  scroll containers, the scrim dismisses modals, and an action targeting
  another window pans the camera there (flow navigation). Nothing can be
  selected, moved, resized, deleted, or re-parented.
- **Edit-mode interactions moved to Shift+Click** — a plain click only selects,
  so editing never fires interactions by accident. Shift+wheel scrolls a scroll
  container; Shift+Click outside an open modal dismisses it.
- **Design notes**: `doc.notes` in the JSON — free-text notes tagged with
  element ids. 🗒 Notes popup above the bottom bar (tag chips select the
  element), and `note list` / `note add "text" [el …]` / `note del <id>` give
  an AI the same access. Notes are the designer↔AI intent channel.
- **Elements tree**: collapsible containers (▾/▸ carets), a search bar that
  auto-expands to hits, and precise drop zones when dragging (row top = before,
  bottom = after, middle of a container = into it) — exact placement even when
  canvas elements overlap.
- **Hover-copy**: hovering a selected widget for 5 s copies "name (id)" to the
  clipboard for use in commands.
- **Flow export grew connections**: a CONNECTIONS section (every
  `action`/`target` and hide/show binding as an edge, classified flow → window /
  modal dialog / in-window) plus the design NOTES.
- **Hit-testing accuracy**: exact containment now wins before the ±8px screen
  tolerance, so clicks at low zoom can't land on the neighbouring row.
- **Output moves to `output/`** in the app folder (read-only installs fall back
  to `~/PixelRuller/output`, then the old Pictures/PixelRuller location). User
  assets live in `<output>/assets`; move any existing files from
  `~/Pictures/PixelRuller/assets` if you have them.

## v0.0.6 — 2026-07-17

- Grow the embedded `aiTheme` template from a colour rule into a full design-cue
  library: `aiTheme.<toolkit>.patterns` now carries 17 GTK cues (plus KDE
  parity) distilled from the example designs — gear-before-switch per-row
  settings, bordered section cards, explanatory titles/subtitles, sidebar +
  page-stack navigation (not tabs), a commit action bar, modal dialogs with a
  scrim (not windows), responsive compact/regular variants, header
  back-navigation, colour-as-status tinting (success/warning/error paired with a
  glyph and text, never colour alone), a content + inspector split, an accent
  drop zone with a click fallback, a clean surface hierarchy, a rounded-corner
  radius scale with a nesting rule, and self-narrating microcopy.
- Add a top-level `icons` rule to the template: use the provided built-in SVGs
  first, and author new ones in the same house style (24×24 viewBox, `fill:none`,
  `currentColor` stroke, `stroke-width 2`, round caps/joins) when one is missing.
- Back-fill the canonical `aiTheme` block into every packaged design
  (`AppLockerUI`, `GnomeSettingsUI`, `ElementRow`, `PDFExtractorUI`) as an
  additions-only edit, so the examples carry the cues on disk and round-trip with
  their shapes unchanged.
- Mirror the whole cue set in the packaged AI guide (AI_SKILL.md) so the skill
  and the JSON each stand alone; verified against the in-app layout self-tests.

## v0.0.5 — 2026-07-16

- Embed an `aiTheme` template in every exported design: instructions that tell an
  AI to translate the mockup's accent hexes into theme tokens and style classes
  (GTK `.suggested-action`, `@theme_selected_bg_color`, KDE `Kirigami.Theme.*`)
  instead of hardcoding colours. `buildExport` stamps the canonical template; a
  design carrying its own round-trips it, and `new canvas` reverts to canonical,
  so the skill and the JSON each carry the theming rule.
- Add a user asset drop folder (`~Pictures/PixelRuller/assets`, PNG/SVG/JPG/WebP)
  served under `assets/user/`, an in-editor "📂 Choose an asset…" picker that
  uploads through `POST /assets/upload` with automatic `_2` de-duplication, and
  `user/<file>` references in the asset list and commands.
- Add batch command construction: `pixelruller-command -` reads one command per
  stdin line and `POST /api/commands` accepts a `commands` array, queued together
  and executed at engine speed (~50/s) with one ✓/✗ result line per command.
- Add visual-fidelity fields across canvas, JSON, XML and HTML export: dashed
  strokes (`strokeStyle`), per-side borders (`borderSides.{t,r,b,l}`),
  caption-in-border legends (`captionMode`/`captionSide`/`captionAlign`),
  `bold`/`italic`/`fontFamily`, drop `shadow`, and a `showText` toggle that hides
  a widget's label and placeholder without deleting the stored text.
- Add a declarative `switch` action (plus `toggle`/`show`/`hide`) with a `target`:
  `switch` reveals the target section and hides its siblings, on canvas clicks and
  in the exported HTML runtime.
- Add `defaults <element> [gtk4|kde]` to reapply documented toolkit metrics and
  registry style to a subtree without touching text, names, state or window size,
  and surface `ungroup` in the toolbox.
- Rebuild the canvas-mode sidebar toolbox as an even two-column grid with related
  actions grouped under Draw / Clipboard / Style / Structure / History sublabels.
- Ship a GNOME switch gear icon pair and an arrow/chevron asset set, and add the
  77-widget GNOME Control Center (`web/GnomeSettingsUI.json`) and element-row
  example designs built entirely through the command grammar.
- Document the full command grammar and stdin batch construction in the README.

## v0.0.4 — 2026-07-15

- Define switches as three independent theme roles: neutral thumb, neutral off
  track, and accent/highlight on track; the track communicates state.
- Document the GTK/GNOME light behavior and require native toolkit tokens for
  dark and high-contrast appearances instead of mechanically inverted colors.
- Document KDE/Breeze's background-color handle, neutral inactive blend, and
  highlight-colored checked track/border from its current switch implementation.
- Add direct GNOME switch and KDE Breeze implementation references to the
  packaged AI guide and detailed widget-library guidance.
- Include `libraries.md` in the Debian package so the README and AI guide's
  detailed toolkit reference remains available after installation.

## v0.0.3 — 2026-07-15

- Complete the layout-fidelity pass: optional section captions, main-axis
  justification, text wrap/ellipsis/clip, nested hug sizing, and scrollable
  overflow now agree across canvas, JSON, XML, and generated HTML.
- Add responsive `hideBelow` / `showBelow` visibility and ship AppLocker regular
  and compact design variants as an editable breakpoint-state proof.
- Add opt-in sidebar hide/show and scroll interactions in the editor and exported
  HTML without turning PixelRuller into a general application-logic engine.
- Add editable composite widgets with independent outer frames, per-corner radii,
  subtree clipping, enter/exit editing, scaling, ungrouping, and serialization.
- Improve GTK and KDE defaults with documented button padding, consistent action
  sizing, shorter labels, neutral switch handles, and guideline-aware AI rules.
- Add semantic HTML export parity for toolkit controls, responsive container
  queries, interaction metadata, and embedded assets.
- Add command-first co-design through `tree`, `inspect`, `selection`, and
  `ui hide|show|toggle`, including a full-canvas focus view.
- Add a thread-safe localhost command queue and the installed
  `pixelruller-command` client so an AI can edit the open canvas without simulated
  mouse or keyboard input while the user watches changes live.
- Add deterministic browser layout self-tests and server tests for the command
  broker, while preserving the existing screenshot backend tests.

## v0.0.2 — 2026-07-15

- Add a responsive window-stage chooser: create an empty GTK/KDE window or
  deep-copy an existing window and every nested widget at a new size.
- Keep every application window and responsive/state variant visible together
  on the canvas for practical comparison and resizing tests.
- Round-trip `variantOf` and `variantLabel` through canonical JSON and XML.
- Extend the design command bar with parameterized empty/copy window commands.
- Ship a complete platform-neutral AI guide covering access, permissions,
  commands, properties, widget catalogue, grouping, layout, official guideline
  sources, and the exact GTK/KDE palettes.
- Add `pixelruller --print-ai-skill` and `--ai-skill-path` for installed AI tools.
- Add a simple transparent GTK-palette PixelRuller application icon.
- Set the PDFExtractor proof-of-concept window to a safe 1000×700 minimum size.
- Require AI co-design handoffs to include clickable artifact/download links.
- Allow installation on systems without a packaged Spectacle; screenshot capture
  remains optional while canvas/UI-design mode stays fully available.
- Auto-detect common KDE, GNOME, MATE, XFCE, Wayland, and X11 screenshot tools,
  fall back between them, and allow any custom capture command through an
  environment-variable template.
- Default screenshot capture to a 10-second countdown and recognize Kubuntu's
  `kde-spectacle` package name in package suggestions.
- Document feature-number/fix-letter versioning.

## v0.0.1 — 2026-07-15

First public release of PixelRuller.

- Measure screenshots with points, segments, areas, snapping, grids, and exact pixel coordinates.
- Design desktop interfaces with semantic GTK/KDE widgets and nested containers.
- Edit hierarchy, sizing, spacing, colors, typography, icons, state, and responsive percentage layouts.
- Export canonical JSON, nested XML, flow outlines, annotated PNG files, and runnable HTML references.
- Share one design between a human visual editor and an AI implementation workflow.
- Include the responsive PDFExtractor redesign as the first proof of concept.
- Ship a Debian package, application-menu entry, command-line launcher, screenshots, and an AI-neutral usage skill.
