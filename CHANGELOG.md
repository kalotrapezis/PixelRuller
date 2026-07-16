# Changelog

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
