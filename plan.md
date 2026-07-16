# PixelRuller → Shared UI Designer — Plan

Living document for where this app is going. Ideas land here first; we implement
in phases. Edit freely.

## The vision

Turn PixelRuller from a *measuring* tool into a **shared UI design tool that both
Teo (visual GUI) and Claude (reads/writes the file + a command API) operate on the
same design**. Instead of sending screenshots back and forth, we keep **one common
design defined by numbers**. Because every element is exact coordinates and
properties, Claude can translate design changes into precise code edits, and Teo can
adjust code-driven layouts by nudging numbers instead of describing them in prose.

Core principle: **the design is data.** A single canonical JSON document
(`design.json`) is the source of truth. The GUI is one editor of it; Claude is
another.

## v0.0.3 release boundary (2026-07-15)

Freeze v0.0.3 after layout/export fidelity, responsive visibility, opt-in UI
interaction, composites, GTK/KDE default corrections, AppLocker regular/compact
proofs, and the first working command-first co-design channel. Defer toolkit
default reapplication, full command parity, `/design`/batch `/ops`, native
GtkBuilder/Qt export, and new macOS/Windows libraries to later releases.

## Active implementation — layout fidelity and canvas parity (2026-07-15)

AppLockerUI exposed a group of editor behaviors that make a valid relative
layout look broken. These are engine problems and must be corrected in the
canonical JSON, canvas renderer, Properties panel, commands, and HTML/XML
exports together. Do not patch individual designs with absolute positioning or
growing Spacer widgets when the layout engine can express the intent directly.

### Data-model decisions

- A Section keeps meaningful `text`, but caption visibility is explicit through
  `showCaption: true|false`. New Sections default to `true`. Legacy files infer
  visibility from non-whitespace text, so the old single-space workaround loads
  without a visible caption. Caption height is reserved only when visible.
- Container alignment is split into two independent properties:
  - `align`: cross-axis item alignment (`start`, `center`, `end`, `stretch`).
  - `justify`: main-axis content distribution (`start`, `center`, `end`,
    `space-between`, `space-around`, `space-evenly`).
- Loader compatibility accepts legacy `left`/`right` and normalizes them to
  `start`/`end`. Commands reject unknown values instead of saving inert data.
- Canvas and generated HTML must use the same axis semantics. Horizontal
  containers use `justify` across X and `align` across Y; vertical containers
  use `justify` across Y and `align` across X.

### Ordered implementation

- [x] **1. Section captions:** add `showCaption` to Properties, JSON/XML and
  HTML; remove the unconditional 22 px canvas reservation and the empty-string
  fallback that forces `Section` to reappear.
- [x] **2. Container positioning:** add the `justify` control and implement
  start/center/end/space distribution in `arrangeInto()` and generated CSS.
  Normalize legacy alignment values during load.
- [x] **3. Command safety:** validate property names, nested side names, enums,
  booleans and numeric ranges for `set`; return a useful error without mutating
  the design.
- [x] **4. Text fidelity:** add wrap/ellipsis/clip behavior to the canvas and
  export, and use wrapped height when a text widget is set to `hug`.
- [x] **5. Nested hug sizing:** measure container descendants, padding, caption
  and gaps before the parent layout pass; repeat layout until nested natural
  sizes stabilize.
- [x] **6. Scrolling parity:** draw automatic scrollbar indicators for a canvas
  container with `overflow: scroll` and non-zero overflow. Keep explicit bound
  Scrollbar widgets available for product designs.
- [x] **7. Toolkit chrome:** replace GTK/macOS traffic lights with GTK-style
  minimize/maximize/close glyph buttons; preserve KDE-specific rendering.
- [x] **8. Editor responsiveness:** keep the canvas usable when side panels and
  Properties are visible at smaller browser widths.
- [x] **9. AppLocker proof:** migrate `web/AppLockerUI.json` to the new fields,
  use `justify: end` for its Action bar, change description labels to fill, and
  add a compact window variant after the engine behavior is stable.
- [x] **10. Verification:** add deterministic layout/serialization checks, run
  the Python tests, inspect AppLocker and PDFExtractor on the canvas, and inspect
  their generated HTML at regular and narrow browser sizes.
- [x] **11. Opt-in UI interaction:** add an Interaction Properties section,
  JSON/XML/command fields, canvas click/wheel behavior, and generated-HTML
  runtime behavior for sidebar toggles and scroll containers. AppLocker uses a
  target-centric `Settings navigation → Back` binding in both variants.

- [x] **12. Embedded AI theme template (2026-07-16):** every exported design
  carries a top-level `aiTheme` block — template instructions that tell an AI to
  translate the mockup's accent hexes into theme tokens/style classes (GTK
  `.suggested-action`, `@theme_selected_bg_color`, KDE `Kirigami.Theme.*`) instead
  of hardcoding colours, mirroring the "Theme-following colours" section of
  AI_SKILL.md. `buildExport()` stamps the canonical `AI_THEME_TEMPLATE`; a design
  that already carries its own `aiTheme` round-trips it (`loadDesign`), and `new
  canvas` reverts to canonical. So the skill *and* the JSON alone each carry the
  theming rule — an AI gets it right the first time from either source. The
  section is regenerated on export, so all existing designs gain it the next time
  they are saved from the app.

- [x] **13. Design-cue pattern library in the template (2026-07-17):** expand
  `AI_THEME_TEMPLATE` beyond colour into the native GNOME/KDE layout & UX
  conventions the example designs use, so an AI reproduces them the first time.
  Under `aiTheme.<toolkit>.patterns` (17 GTK cues + KDE parity): gear-before-switch
  for per-row settings, bordered section cards, explanatory titles/subtitles, row
  layout, sidebar+page-stack navigation (not tabs), commit action bar, modal
  dialogs with a scrim (not windows), responsive compact/regular variants, header
  back-navigation, colour-as-status tinting (success/warning/error + glyph + text,
  never colour alone), content+inspector split, drop zone with a click fallback,
  clean surface hierarchy, a rounded-corner radius scale + nesting rule, and
  self-narrating microcopy. Plus a top-level `icons` rule: use the provided SVGs
  first, author new ones in the same 24×24 / `fill:none` / `currentColor` /
  `stroke-width 2` house style. All mirrored in AI_SKILL.md; verified against the
  38 in-app self-tests.

- [x] **14. Back-fill the template into shipped designs (2026-07-17):** inject the
  canonical `aiTheme` block into every packaged design JSON
  (`AppLockerUI`, `GnomeSettingsUI`, `ElementRow`, `PDFExtractorUI`) as an
  additions-only edit (no shape reflow), so the examples themselves carry the
  cues on disk rather than only on the next re-export. Each round-trips through
  `loadDesign`/`buildExport` with shapes preserved.

### Completion rule

Each field must round-trip through JSON and XML, produce equivalent generated
HTML/CSS, be editable in Properties, and be accepted with validation through
the command line. A canvas-only option or an export-only option is incomplete.

### Create-mode UI layout (target — from Teo's mockup 2026-07-07)

The canvas ("create") mode is heading toward this layout. Screenshot ("showcase")
mode is done and stays as-is.

```
┌──────────────────────── top toolbar (New · MODE · Rect/Ellipse/Select · Grid · … · Save/JSON/Load) ┐
│ ┌────────┐                                                              ┌──────────────┐ │
│ │ tools  │            ┌───────── window ──────────┐                     │  Library     │ │
│ │ (shape │            │                           │   ┌ Window props ┐  │  [ GTK 4 ]   │ │
│ │  & tool│            │        the canvas         │   │ radius  [20]  │  │  Input       │ │
│ │  icons)│            │    (windows/elements)     │   │ height  [200] │  │  Toggle      │ │
│ │        │            │                           │   │ width   [200] │  │  Textbox     │ │
│ └────────┘            └───────────────────────────┘   └── px / % ─────┘  │  Output/Label│ │
│                                                                          │  File/local… │ │
│ ┌──────────────────────────── bottom command line ──────────────────────┴──────────────┐│
│ │ [quick funcs]  cmd:[__________________________]  [quick funcs]                        ││
│ │ [__________]   history of commands  ▓▓▓▓▓▓▓▓▓▓▓▓                        [__________]   ││
│ └───────────────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Toolbar split (decided 2026-07-07): in creation mode the **top** bar keeps only
file/mode ops (New · mode/tools · element name/colors · Undo/Clear · Save/JSON/
Load); the **view/tool options** (grid, show-numbers, and element snapping) move
to a **bottom bar**, which will also host the command line + history.

**Elements tree (DONE 2026-07-09):** collapsible "Elements" section in the left
sidebar (widened to 300px) between Tools and Properties — the full hierarchy
(windows → children by slot, plus "(free)" elements), visible even when a wrong
z hides something on canvas. Click selects, **drag a row onto a container**
(→ its last child) **or onto a sibling** (→ slot before it, lifted above its z),
**▲** brings to front. Cycle-safe; per-row shows type + z.

**Left sidebar — properties + tools (DONE 2026-07-08):** the element
properties move from the floating right-click panel to a **docked left sidebar**,
shared with the tools as collapsible categories (Tools / Properties sections).
Selecting an element populates the Properties section; right-click still selects
but no floating panel — cleaner, always in the same place, no canvas overlap.

Properties panel (target): categorized **collapsible sections** (hamburger-style,
arrangeable horizontal or vertical) with richer controls — number inputs,
**sliders** (with value indicators), **checkboxes**, status **indicators**.
Property coverage grows to: position/size, **border** (stroke color/width/on-off),
corner radius, fill (on/off + color), **text** (content, **font size**, **title/
text placement** via H+V alignment), notes, and per-widget extras.

Pieces (each becomes its own build task):
1. **Left tools palette** — basic shapes + tools as a grid of icons (rect,
   ellipse, line, text, …), collapsible.
2. **Center canvas** with a **window** as the top-level container element; UI
   elements live inside windows. "On creation, move away from basic shapes → to
   UI elements": a placed shape can be promoted to a typed widget.
3. **Ctrl+Click → floating element Properties panel** (radius, height, width, …)
   with a **px / %** units selector (% relative to the parent window/canvas).
   → building this first; also covers the "numeric X/Y/W/H" TODO.
4. **Right Library panel** — premade widgets organized by **toolkit**. Two UI
   libraries to start: **GTK 4** and **KDE** (see `libraries.md` for researched
   defaults). Widgets: Input, Toggle, Textbox, Output, Label, File, local
   storage, **sections/containers**, **indicators**, **checkboxes**, **sliders**,
   **scrollbars (in divs)**, **lists** (with a `count` property = how many
   rows), **clocks**, **calendars**, and **floating/hamburger panels** with
   **horizontal or vertical** layout. Click/drag to insert. Toolkit is switchable
   so exported names/props match the target framework.
   - **One-click library defaults:** each widget carries the toolkit's
     recommended paddings, margins, size, corner radius, and spacing (from
     `libraries.md`), so inserting or "apply defaults" gives correct metrics
     instantly.
5. **SVG icon assets** — real icons come from SVG files the user drops into an
   `Assets/` folder organized by file type (`Assets/svg/…`). An `svg`/`icon`
   element type references a file and renders it on the canvas; the library lists
   available assets. See `Assets/README.md`.
6. **Bottom command line** — AutoCAD-style `cmd:` input driving all tools, with a
   scrollable **command history** and quick-access "basic functions" on each side.
   Shares the operation grammar with the HTTP command API (Phase 5).

### Windows, responsive variants & terminology (updated 2026-07-15)

- **Window = the unit of design** (PC has windows, not phone "screens"; analogous
  to Android *Activities*). A new canvas seeds one Window named **"Session"** by
  default.
- **Multiple root windows stay visible together** in the canvas window table.
  They can represent different application windows, responsive sizes of the same
  interface, or stages such as default/loading/complete. A duplicated stage owns
  a complete remapped widget tree and records `variantOf` / `variantLabel`.
- **Place widgets per library layout**: when inserting into a window, position
  using the active toolkit's spacing/margins from `libraries.md` (KDE or GTK 4).

### Window = a root parent (updated 2026-07-15)

There is **always at least one Window**. A new canvas begins with "Session";
additional roots are added empty or by deep-copying an existing window. The final
root cannot be deleted.
The canvas **scale %** (view zoom) is shown so you know if you're at 100%. The
window's width and height are design data; duplicated variants reflow their own
complete widget tree at the chosen dimensions.

### Sections as layout containers (decided 2026-07-07)

A **Section** is a layout container, not just a box. It has a `layout`:
- **vertical** — one column, children stacked top→bottom.
- **horizontal** — one row, children left→right.
- **table** — a grid (rows × columns).
Plus an **align** (left / center / right) for how children sit, and
`gap`/`padding`/`margin` (seeded from the toolkit's `libraries.md` defaults).
Children are the elements whose center is inside the section; an **Arrange**
action repositions them per the layout. **Nested sections** compose complex
layouts. **Group/ungroup** wraps selected elements into a section (needs
multi-select — a prerequisite to build first).

### Toolkit window styling (decided 2026-07-07)

- **GTK**: the **titlebar is part of the window body** (a headerbar) with larger
  corner radius; window buttons (min/max/close as circles) + a **hamburger** for
  less-common actions, defaulting to the **right** (movable to the left).
- **KDE**: **small** corner radius (never interfering with content) and a more
  traditional separate titlebar feel.
The Window renders differently per its `toolkit`, and a `buttonSide` (left/right)
controls where the controls sit. (2026-07-09: KDE now draws a real **separate
titlebar** — solid strip with its own `barFill` color + separator line — vs
GTK's integrated headerbar. New windows default to the existing windows' size.)

**Windows as presets (ACTIVE — first slice DONE 2026-07-12):** windows are real
editable widget trees, not plain drawings. New designs and the + button create a
toolkit preset. GTK: Window → Title bar + body. KDE: Window → Menu Bar →
Main Toolbar → Content. KDE menubars/toolbars are typed horizontal containers with
real Menu item / Tool button / Separator children. Every part can be selected,
reordered, restyled, dragged into, and exported through parent/slot data.

**GTK default correction (2026-07-12):** `presets/GTK-Start.xml` is the
authoritative minimal GNOME window. GTK is Window → Title bar + body spacer;
the Title bar directly owns Forward, Backward, New Tab, a growing centred title,
Hamburger, and Window controls. It has no separate Header Tools or Content rows.
KDE keeps its traditional separate titlebar/menubar/toolbar/content stack.

**KDE default correction (2026-07-12):** `presets/KDE-Window.xml` is the KDE
visual reference. Its full-width rows are Title bar → Menu bar → Main
toolbar → Content. The toolbar contains Back, Forward and New Tab, then a
growing spacer, Search field and Hamburger at the end.

#### Window-to-full-widget TODO (ordered)

- [x] Explicit `parent` + `slot` tree and automatic container layout.
- [x] Library widget cards drag onto the canvas; drop point chooses the smallest
  Window/Section and inserts into its slot. Click-to-add remains available.
- [x] Toolkit window presets composed from real widgets; + adds the active
  toolkit preset; uniform window sizing remains.
- [x] Make Menubar and Toolbar real containers; add Menu item, Tool button, and
  Separator child widgets.
- [x] Add the remaining chrome widgets: **title/header bar**, status bar,
  tab strip, breadcrumb/path bar, search field, split pane, spacer, and movable
  window controls. Tabs activate directly when clicked on the canvas; repeatable
  tab-item children remain part of the collections task below. (2026-07-12)
- [ ] Add toolkit **system icon packs** and an icon-name property on Tool button,
  Button, Menu item, Textbox actions, and window controls; light/dark variants.
  - [x] First slice (2026-07-12): existing SVG assets can be selected directly
    on Button, Tool button, Menu item, and Textbox widgets, with icon size,
    placement, gap, icon-only mode, and JSON/XML round-trip. Window controls and
    automatic toolkit light/dark variants remain.
- [x] Add layout sizing rules per child: per-axis fixed / fill / hug-content,
  min/max width+height, grow weight, proportional width/height percentages;
  container wrap/columns; table row/column
  spans. Properties, commands, style-copy and JSON all share the same fields.
- [x] **Responsive visibility state (2026-07-15):** `hideBelow` / `showBelow`
  switch elements at a Window-width breakpoint in the canvas, hit-testing,
  JSON/XML and generated HTML container queries. AppLocker proves the pattern:
  its compact state hides navigation, expands content, and shows a title-bar
  Back button. Layout/sizing overrides at breakpoints remain a later extension.
- [x] Add per-widget text overflow rules (wrap / ellipsis / clip). Narrow
  controls currently draw long dropdown, textbox and checkbox labels beyond
  their bounds even though their boxes resize correctly.
- [x] Add overflow behavior: visible / clip / scroll, derived scroll extents,
  numeric X/Y offsets, nested viewport clipping, clipped hit-testing, and an
  optional fixed Scrollbar → parent binding (value 0–100 maps to scroll range).
- [x] **Opt-in interaction (2026-07-15):** Properties can enable a sidebar and
  name the Button/Tool button/Menu item that toggles it, or configure the target
  on the control. Enabled scroll containers respond to the wheel; exported HTML
  preserves both behaviors without turning general product logic into editor
  runtime code.
- [x] **Tool safety separation (2026-07-12):** Select changes selection/marquee
  and may resize via handles but never moves/reparents/reorders; Move is the only
  layout-moving tool; Camera pans without design mutations. Space-drag and
  middle-drag are Camera shortcuts consumed before object hit-testing.
- [x] **Command-first co-design parity (2026-07-15):** make every normal build/edit
  operation available through the same command engine so an AI can work without
  pointer-driven canvas manipulation while the user keeps a clear view of the
  application.
  - [x] Add `tree [root] [all]` with hierarchy indentation plus id, widget type,
    parent/slot, x/y/w/h, fill/stroke, responsive/runtime visibility, fixed state,
    and an accent-colored selected marker in the command log.
  - [x] Add `inspect <element>` for the complete editable property/state summary and
    `selection` for the current multi-selection.
  - [x] Audit parity (2026-07-15): added the missing verbs — `select` with
    multiple references plus `select add` / `select none` (multi-select),
    `group [name]` (Ctrl+G parity), `front` / `back` (z-order buttons),
    `cut` / `paste` (clipboard parity) and `style copy <el>` /
    `style apply [<el> …]` (🖌 buttons). Single-reference commands accept
    unquoted multi-word names; lists need quotes.
  - [x] `defaults <element> [gtk4|kde]` (2026-07-15): reapplies the documented
    toolkit sizes (fixed axes only), radius, padding, gap and the registry's
    visual style to the whole subtree via `applyToolkitDefaults()`; semantic
    text, names and state stay untouched, and Window dimensions are preserved.
    Toolkit defaults to the element's own, then the active Library toolkit.
  - [x] Expose a local command transport that invokes the exact in-app command engine
    without simulated mouse/keyboard input. Keep commands and results visible in
    history so human and AI share the same audit trail.
  - [x] Add `ui hide|show|toggle` command focus: hide toolbar/sidebars/bottom bar
    and number overlays while preserving a full live canvas; Ctrl+Shift+U restores.
  - [x] Keep browser control only for opening/loading and final visual QA; it must not
    be the primary construction/editing interface.
  - [x] **Bulk-build ergonomics (2026-07-15, GNOME Control Center proof):**
    `new canvas <w> <h>` starts a design from the CLI; `add <kind> [into <c>]
    with <prop> <value> …` creates a named, styled widget in one command (pairs
    validated before creation, `name`/`slot` included); `add` returns the new
    element's id/name as data; the editor drains the whole remote queue per
    poll tick; `POST /api/commands` accepts a `commands` array and
    `pixelruller-command -` batches stdin lines. Rebuilt gnome-control-center
    (84 commands, 77 widgets) in under 2 s with command-only construction.
    Engine fixes found by the proof: `add into` no longer routes through the
    canvas-centre insert (a transient adopt/stretch pass permanently corrupted
    geometry); windows with a Title bar anywhere in their subtree suppress the
    painted fallback chrome and its 44 px reservation (split sidebar/content
    headers work); a hug container follows its content instead of flooring at
    the library's default widget size.
  - Remaining for full co-design flow: `save`/`load` design commands and the
    Phase 5b/5c `GET /design` + `POST /design` document endpoints, GNOME-style
    row separators (horizontal `separator` orientation), and repeatable
    collections for real list rows.

### Active batch — CLI-complete visual fidelity (2026-07-15, from the GNOME proof)

Goal: **the CLI can do anything, with ease** — an AI without live-canvas access
(ChatGPT-style) must be able to construct the complete picture over commands
alone. Every feature below mirrors real code and must round-trip JSON/XML,
export to generated HTML, and be settable through commands. Ordered; tick as
they land:

- [x] **Remove the painted fallback window chrome (2026-07-15).** Windows draw
  only their frame now; all chrome is real child widgets. `containerHeadOffset`
  reserves nothing for windows and only reserves caption space for block-mode
  section captions.
- [x] **DONE (2026-07-15) — Borders that mirror CSS/toolkit frames.** `strokeStyle: solid|dashed`
  (sections become solid by default — the dashed look was an editor artifact),
  per-side enables `borderSides {t,r,b,l}` (GNOME row dividers = bottom-only
  border, exports as `border-top/right/bottom/left`), and **caption-in-border**:
  `captionMode: block|border` + `captionSide: top|bottom` + `captionAlign:
  left|center|right` — a section title sitting on the border line, exported as
  HTML `fieldset/legend`, mapping to GtkFrame / QGroupBox.
  Complete end-to-end: canvas rendering, per-side `border-*` CSS + dashed
  style + `.sr-legend` span in generated HTML, JSON/XML serialization,
  command validation (`strokeStyle`/`captionMode`/`captionSide`/`captionAlign`
  enums, `borderSides` and `borderSides.t/r/b/l` booleans with a dedicated
  set-path branch), and selftests (28/28). Properties-panel controls for the
  new fields remain a TODO — commands are the primary surface.
- [x] **DONE (2026-07-15) — Button UI actions.** `action: none|toggle|show|hide|switch` + `target`
  on Button/Tool button/Menu item: declarative UI-only behavior (sidebar
  toggles, content-pane switching). `switch` shows the target and hides its
  sibling sections. Works on canvas click and in exported HTML runtime; kept
  out of application-logic territory. Supersedes the target-centric
  `interactionControl` as the preferred authoring direction (old fields keep
  loading).
- [x] **DONE (2026-07-15) — Text styling:** `bold`, `italic`, `fontFamily` on
  text-bearing widgets. Complete end-to-end: all six widget-text `g.font`
  assignments use `fontStyleCss(s)` + `s.fontFamily`, generated HTML emits
  `font-weight/style/family`, JSON/XML round-trip, `bold`/`italic` booleans and
  `fontFamily` string validate in commands, selftests cover CSS + JSON + XML.
  Properties-panel controls remain a TODO alongside the border fields.
- [x] **DONE (2026-07-15) — Shadows:** `shadow` boolean on any boxed widget →
  canvas drop shadow (window 26/8, others 10/3) + CSS `box-shadow`; new preset
  windows enable it.
- [x] **DONE (2026-07-15) — Name labels off by default in canvas mode** —
  `newCanvas()` clears show-numbers (the checkbox re-enables); screenshot-mode
  loads keep labels on since measuring is their purpose.
- [x] **DONE (2026-07-15) — Arrow/chevron SVG assets:**
  `arrow-left/right/up/down.svg` + `chevron-left/right/up/down.svg` added to
  `Assets/SVGs`, consumable through the button `icon` property.
- [x] **DONE (2026-07-15) — GNOME Control Center re-verified** via CLI only
  (84 build + 54 refinement commands): bottom-border row dividers, bold
  headings, chevron icon in the Configure row, shadowed window; canvas and
  generated HTML both match the reference; 34/34 selftests; fixture updated
  at `web/GnomeSettingsUI.json`.

**Batch complete (2026-07-15).** Every item above landed and is covered by the
34 browser selftests plus the CLI-rebuilt GNOME fixture. Follow-ups carried
forward: `save`/`load` design commands + `GET/POST /design` endpoints,
horizontal `separator` orientation, and repeatable collections.

**Editor-UI pass (2026-07-15):** the sidebar toolbox is a two-column grid with
sublabeled groups (Mode / Draw / Clipboard / Style / Structure / History);
sublabels hide when the groups return to the top toolbar in screenshot mode.
The Properties panel gained controls for every new field: Drop shadow
(Appearance), border Style solid/dashed + per-side T/R/B/L checkboxes
(Border, sections/windows), caption mode/side/align (Text, sections),
Bold/Italic/Font family (Text), and Action + Target selects (Interaction,
controls) — all live-wired through `syncPropPanel`/`applyPropPanel`.
`runLayoutSelfTests` now repaints the real document after restoring state.
Added `showText` (2026-07-15): a Show text checkbox in the Text section (and
`set <el> showText false`) hides any widget's label **and** its placeholder
fallback without deleting the stored text; suppressed on canvas, in hug
measurement, and in generated HTML; JSON/XML round-trip; 38/38 selftests.
The dashed selection highlight also moved 3 px outside element bounds in
accent color, so solid/per-side element borders stay readable while selected.

**Text-model cleanup (2026-07-15):** Show text off disables (greys) the whole
Text category in Properties — element Name is unaffected — and now overrides
the section caption too (`sectionCaptionVisible` checks `showText`, so the
22 px strip also collapses). **Sections are pure layout containers by
default:** new sections get empty text and `showCaption: false`; a section
title is a Label child, or an explicitly enabled caption (block or
border/legend mode). Old files with stored captions load unchanged. The
border-Sides checkboxes keep each T/R/B/L letter glued to its own box.

**Assets pipeline (2026-07-15):**
- User drop folder `~Pictures/PixelRuller/assets/` (auto-created,
  `user_assets_dir()`): PNG/SVG/JPG/WebP files appear in `GET /assets` as
  `user/<file>` and serve from `/assets/user/…`.
- The Image widget renders its `src` letterboxed inside its frame (radius
  clipped) on canvas; `src` round-trips JSON/XML (`set <el> src user/x.png`).
- The Properties Asset picker (shared by button icons and Image src) is
  grouped: None · **📂 Choose an asset…** · separator · Your assets ·
  Built-in icons. The picker uploads via `POST /assets/upload` (server copies
  into the drop folder; filename collisions get `_2`/`_3` suffixes; non-image
  types rejected); the list refreshes and the new asset is selected.
- New `assets [filter]` command lists all assets from the command bar/CLI.

Follow-ups: refresh the cached asset list when files are dropped into the
folder while the editor is open (currently needs a Library reopen), and a
Library "Your assets" group mirroring the Properties picker.

**Parked design — anchored popovers (hamburger menus, 2026-07-15):** mirror
GtkPopover/QMenu: the floating menu is a normal Section (children = Menu
items) with a new `anchor: <control>` field instead of a layout slot. It does
NOT occupy a slot in the anchor's container; each relayout computes its x/y
from the anchor's position (default below the control, edge-aware), it draws
in the Window's overlay layer (above all siblings), and starts
`runtimeVisible: false`. The control opens it with the existing
`action: toggle` + `target`. Export: HTML absolutely-positioned near the
anchor with the existing click runtime; GtkBuilder → GtkPopover attached to
the widget; Qt → QToolButton menu. `anchor` is the only new field needed.
- [ ] **Composite widget grouping:** select three or more widgets and
  choose **Make Widget** to wrap them as one named composite (for example, all
  GNOME/KDE chrome pieces → `Window`). The composite behaves as one item for
  selection, move, resize, copy/paste, ordering and export, while retaining an
  editable child tree.
  - The composite owns a distinct **outer frame layer** (`fill`, border color /
    width / opacity, radius, padding and overall size). Editing these properties
    changes only the outer boundary, never every child's border/background.
  - **Outer radius is a clipping mask, not a propagated child radius.** A radius
    such as 25 clips the completed composite only at its four outside corners;
    it does not assign radius 25 to every contained section and does not add
    padding or displace content.
  - Edge-aware result for stacked window chrome: the Title bar stays internally
    rectangular and is clipped only where it touches the composite's **top-left /
    top-right** corners; the Content section stays internally rectangular and is
    clipped only at the composite's **bottom-left / bottom-right** corners. Their
    shared inside edge remains perfectly square. Middle rows receive no corner
    rounding at all.
  - Rendering order: draw the composite frame/background, clip all descendant
    painting and hit-testing to one rounded outer path, draw children normally,
    then draw one outer border above them. Selection handles follow the same
    outer path. Child geometry remains unchanged.
  - Support independent corner values (`radiusTL`, `radiusTR`, `radiusBR`,
    `radiusBL`) with a linked **All corners** control. Exporters should use native
    per-corner radii where available or an outer wrapper/clip without modifying
    child styles.
  - Child styles remain independent. Enter/Edit composite (double-click or the
    Elements tree) exposes its children; leaving it returns to one-object
    selection. Normal click targets the composite first.
  - Resizing offers two explicit modes: **resize frame/reflow children**
    (default, layout-aware) and **scale everything** (optional proportional
    scaling). Moving always moves the full subtree as one unit.
  - **Ungroup** removes only the composite frame and re-homes its children
    without changing their appearance. Nested composites are allowed and
    cycle-safe.
  - JSON/XML store the composite parent/slot tree plus outer-frame style
    separately from child styles. Commands gain `make-widget`, `enter`, `exit`,
    and frame-only `set` operations.
  - GTK and KDE window presets become named composites using this same model,
  rather than special-case painted chrome; their outer Window border belongs
  to the composite frame and their title/menu/tool controls remain children.
  - [x] First complete slice (2026-07-15): **Make Widget** wraps 3+ selected
    top-level elements without changing child geometry; normal canvas clicks
    select the wrapper, while Enter/double-click or the Elements tree exposes
    children and Exit restores one-object selection. The wrapper has a separate
    `frame` object, linked or independent TL/TR/BR/BL radii, rounded descendant
    clipping and one border above the subtree. Move, delete, hierarchy-aware
    copy/paste, default frame/reflow resize, optional proportional scale resize,
    safe ungroup, JSON and nested XML round-trip, plus `make-widget`, `enter`,
    `exit`, `ungroup` and `set <widget> frame.*` commands are implemented.
    Remaining in this item: migrate GTK/KDE root Window presets onto the same
    frame model and add toolkit-native per-corner export validation.
- [x] Add visible drop affordances: highlight the target container and draw the
  exact insertion line/slot before release; support drag directly from the
  Elements tree and Library with the same operation. (2026-07-15: both drag
  sources share the same smallest-container/slot preview and cycle-safe drop.)
- [ ] Add repeatable collections: menu items, toolbar actions, tabs, list rows,
  table columns, and tree rows as editable children instead of count-only art.
- [ ] Add widget semantics/state: enabled, visible, focused, selected, checked,
  placeholder, validation/error, tooltip, shortcut, accessible name/role.
- [ ] Add actions/connections: click/change/submit/activate → command, effect,
  frame, or another Window; expose them in Properties and `design.json`.
- [ ] Add interactive Preview mode that runs local widget states/actions without
  changing the canonical design.
- [ ] Add toolkit-default application/migration: reapply GTK/KDE metrics to one
  subtree and convert a preset between toolkits while preserving content.
- [ ] Export nested parent/slot trees directly to GtkBuilder and Qt `.ui`, with
  a validation report for unsupported properties and widgets.
- [ ] Save a selected subtree as a reusable custom component/preset with instance
  overrides (Phase 4).

### Relationships & drag-drop parenting (decided 2026-07-08)

Every shape has a stable `id`. A `parent` (container id) makes explicit parent-
child relationships: **drag an element onto a Window/Section and drop it → it
becomes that container's child**, hooked into the container's layout (arrange
uses `parent`, not just geometry). The properties panel shows the **Parent**
(editable) and the **children** count. Dropping outside all containers clears the
parent (or falls back to the root Window).

### Layout-first canvas — App Inventor model (decided 2026-07-08)

The canvas becomes **slot-first, not geometry-first** (like MIT App Inventor):

- **Canvas accepts only Windows** (+ their states/frames, + a "+" to add more).
  Everything else must live inside a container; dropping on empty canvas
  reparents to the root Window.
- **Children are an ordered list** (`children[]` by slot index), not coordinates.
  Containers lay out their children **automatically on every change** (single
  top-down pass from the Window) — `arrangeChildren` stops being a button and
  becomes the renderer's layout pass. Drag-drop inserts at a slot between
  siblings; element x/y becomes *computed* output, not stored input.
- **Pixel positions only as `fixed` within a cell**: a child may opt into
  `fixed: true` + x/y offset relative to its cell (the GtkFixed escape hatch).
- Spacing comes from the toolkit defaults (`libraries.md`) — gap/padding/margin
  per container, three layouts only (vertical / horizontal / table) + align.
  **No constraint solver, no wrapping/flex semantics** — keep it ~100 lines.
- **Why:** GTK 4 / Qt `.ui` files have no x/y — they're layout trees. Slot-first
  is the only model that exports to clean real code (Phase 6). This resolves the
  "Coordinate space" open question: the unit is *slot in container + toolkit
  spacing*, px only as the escape hatch.
- **Scope guard:** it stays a mockup tool — no logic blocks, no event handlers;
  actions remain declarative data for the flow chart.
- **Migration:** legacy designs with absolute x/y load as `fixed` children of
  the root Window.
- **Window table, no canvas (DONE 2026-07-08):** creation mode draws **no
  document background or grid** — the workspace is just the **table of
  windows**: one column, one row per window (margin/gap 60), stacked by
  `layoutWindows`, which also auto-sizes the document extent to the content.
  A floating **＋ button** (bottom-right of the stage) adds a Window as a new
  row. Grid controls are screenshot-mode-only now; saved PNGs get a bgColor
  fill since the live canvas is transparent behind the windows.
- **First slice (DONE 2026-07-08):** windows are **managed** — auto-stacked
  vertically (`layoutWindows`, gap 40), not draggable, no canvas resize handles
  (size edited in Properties; X/Y disabled there). A `relayout()` pass runs
  after every structural change (drag drop, insert, paste, delete, property
  edit, load): it stacks windows (children travel with them) then auto-arranges
  every container whose `layout` ≠ none — the Arrange button is now only for
  manual/no-layout containers. `fixed: true` children are skipped (escape
  hatch).
- **Explicit parent/slot (DONE 2026-07-08):** every element carries
  `parent` (container id) + `slot` (ordered position). Dropping a moved /
  drawn / inserted / pasted element **adopts** it into the container under its
  center and inserts it at the slot matching the drop position between
  siblings (`adoptShape`); dropping outside clears the parent. `arrangeInto`
  orders by slot (geometry fallback for legacy shapes) and normalizes slots;
  `relayout` arranges outer containers before nested ones. The properties
  panel has an editable **Parent** dropdown (subtree-safe) and a **children
  count** for containers. Group sets the section as parent (ordered);
  ungroup/delete re-home children to the removed container's parent.
  id/parent/slot round-trip through JSON.

### Copy helpers

- **Copy/Paste style** (DONE 2026-07-08): 🖌 Style / 🖌 Apply buttons in the
  Tools section — copy the selected element's effective style (fill, border +
  opacity, radius, opacity, font, text colors, alignment, margin/padding, gap)
  and apply it to any selection.
- **Per-field copy** buttons next to color / font-size etc. to grab a single
  value. (TODO)

### Theme palettes (DONE 2026-07-08)

Bottom bar: **GTK (Adwaita) / KDE (Breeze) light & dark** palettes as swatches
(roles: bg, surface, view, border, text, muted, accent×2, success, warning,
error). Click a swatch → fill the selection; right-click → border. **🎨 Theme
design** recolors the whole design by widget role (window→bg, button→accent,
textbox→view, …).

- **TODO — bottom-toolbar color picker:** add a free-form color control beside
  the theme swatches so any color can be chosen without opening Properties.
  It should show the current hex value, support direct hex entry and the native
  picker, remember recent custom colors, and apply to the current selection as
  **fill by default** with an explicit Fill / Border / Text target selector.
  Keep the toolkit palettes as recommended colors; the picker is the custom
  override path.

### Border & spacing properties (DONE 2026-07-08)

The properties panel has a dedicated **Border** section (color, width,
**opacity** — rendered via rgba) and per-side **Margin / Padding (T R B L)**;
containers gained a **Gap** property. `arrangeInto` honors container padding
sides, per-child margins, and gap. All round-trip through JSON (numbers from
old files auto-normalize to per-side objects via `side4`).

### Transparency

Element **opacity** (0–100 %) is a property (canvas `globalAlpha`); unchecking
**Filled** removes the fill entirely. Both are in the properties panel.

### Interactive widgets (planned — Preview/Interact mode)

Widgets are static in *design* mode. Add a **Preview/Interact mode** toggle where
they respond: toggle flips `on`, checkbox/radio flips `checked`, slider sets
`value` from the click position, and a **button follows a connection** to the
target window/frame (drives the flow). Design mode stays for editing; preview is
for clicking through the prototype. (No live text entry needed — it's a mockup.)

### Export format: JSON canonical, XML as an output (decided 2026-07-07)

Yes, most UI toolkits use XML under the hood (GTK **GtkBuilder `.ui`**, Qt/KDE
**`.ui`**, Android layouts). But JSON stays the **canonical working format** —
it's native to the browser app, easy to diff, and what Claude reads/writes.
We **add XML as an export** (a nested `canvas > window > widget` tree), first
generic, then targeting GtkBuilder/Qt `.ui` per the chosen toolkit — that's the
bridge to real code. So: edit in JSON, export JSON *and* XML.

### Icons as widget properties (planned)

Besides standalone icon elements, a widget (e.g. Button) can carry an **icon
property** (`icon: "SVGs/…"`, plus icon side/size) so buttons render label + icon.
The Library "Icons" tab feeds both standalone icons and this property.

### Code-binding format (draft)

Every element may carry a `code` object mapping it to real source, so numeric
design edits translate to precise code changes:

```jsonc
"code": {
  "framework": "gtk4",              // gtk4 | kde/qt | web | react | …
  "component": "GtkButton",         // widget class / component name
  "id": "save_btn",                 // object name / element id / selector
  "file": "src/ui/main.ui",         // where it lives (optional)
  "props": { "label": "text", "sensitive": "!disabled" },  // design→code prop map
  "signals": { "clicked": "on_save_clicked" }              // action→handler
}
```

Toolkit choice (GTK 4 / KDE) drives default `framework`, component names and the
prop map. The flow chart's connections become signal→window navigation.

### Rotate (planned)

A `rotation` (degrees) property with a rotate handle + numeric field; snap to
15°/45°/90°. Needs rotated hit-testing/handles — deferred until it can be done
cleanly (current elements are axis-aligned).

### Two modes, two jobs (decided 2026-07-07)

- **Screenshot mode = communicating.** Works exactly like today: capture the
  screen, then *point things out* with points and areas. Its purpose is to
  convert "look at this" into numbers, so Claude knows exactly what Teo means
  without interpreting photos. Keeps the measuring toolset (points, areas,
  snap, typed distance, equalize) — this mode is feature-complete in spirit;
  it only gains polish.
- **Canvas mode = designing.** A blank canvas has nothing to point at — every
  item is *placed*, and automatically has a name and an exact position. So no
  point/area pointing tools here; instead an **assets & shapes palette**
  (icons for shapes and widgets). Design structure comes from three things:
  - **Visible window table** — all application windows and responsive/state
    variants remain on the same canvas for side-by-side testing.
  - **Actions** on elements (a button's click, a menu item) declared as data.
  - A **connections view**: every window shown as a label with the list of its
    buttons/actions, and edges connecting each action to the window it opens
    (or the effect it triggers). Because windows, actions, and connections are
    all data, the app can generate a **flow chart automatically** as an output
    (render in-app + export).

## Why this answers "can Claude use the app?"

Today Claude can only *read* an exported `design.json`. The plan makes the shared
document a first-class, two-way interface:

1. **File-based (Phase 5a, do first).** The app continuously saves `design.json`
   to a known path (in the repo). Claude reads it, edits it, and the app
   hot-reloads to show Claude's changes. Simplest, no networking, works offline.
2. **HTTP command API (Phase 5b).** The local server exposes endpoints Claude can
   call directly:
   - `GET /design` → current document
   - `POST /design` → replace document
   - `POST /ops` → apply a list of operations (see "Operation schema")
   The GUI reflects changes live via polling / server-sent events.
3. **Operation log.** Every edit (from either side) is an operation object, so
   changes are diffable, replayable, and reviewable — not opaque file rewrites.

Recommended order: 1 → 3 → 2.

## Data model (draft schema)

```jsonc
{
  "app": "PixelRuller",
  "version": 2,
  "mode": "design",                   // "screenshot" (measuring) | "design" (canvas)
  "windows": [                        // one per tab — each window of the designed app
    {
      "id": "win_main",
      "name": "Main window",
      "canvas": { "width": 1920, "height": 1080, "units": "px", "background": "#ffffff" },
      "background_image": null,       // optional screenshot to trace/redline over
      "elements": [ /* array of elements — full example below */ ]
    }
  ],
  "connections": [                    // action → target window/effect (drives the flow chart)
    { "from": { "window": "win_main", "element": "el_1", "action": "click" },
      "to":   { "window": "win_settings" },        // or { "effect": "save file" }
      "label": "opens" }
  ],
  "element_example": [                // the shape of one windows[].elements entry
    {
      "id": "el_1",                  // stable, referenced by ops and by code binding
      "type": "button",             // see element types below
      "name": "Save button",
      "x": 100, "y": 40, "w": 120, "h": 36,
      "rotation": 0,
      "radius": 8,                   // corner roundness (px), per-corner later
      "fill": "#4a9eff",
      "stroke": "#2f7de0", "strokeWidth": 1,
      "text": "Save", "fontSize": 14, "textColor": "#ffffff", "align": "center",
      "z": 3,
      "notes": "Primary action. Disabled until form valid.",
      "actions": [                   // what this element can do (feeds connections)
        { "name": "click", "description": "save the form" }
      ],
      "code": {                      // optional binding to real code (Phase 6)
        "component": "PrimaryButton",
        "file": "src/components/Toolbar.tsx",
        "selector": "#save"
      },
      "props": {}                    // type-specific extras (e.g. toggle 'on')
    }
  ],
  "components": [                     // reusable custom elements (Phase 4)
    { "id": "cmp_card", "name": "Card", "elements": [ /* primitives */ ] }
  ]
}
```

Geometry remains absolute px in canvas space for deterministic export, while
managed layouts can derive child width/height from fill, hug-content, grow
weights, or explicit percentages. The computed x/y/w/h stay exportable.

### Element types (library)

- **Primitives:** `rect`, `ellipse`, `line`, `text`, `image`, `icon`.
- **UI controls:** `button`, `textbox`, `label`, `toggle`, `checkbox`, `radio`,
  `slider`, `dropdown`.
- **Structural:** `group` (children), `component` (instance of a saved component).

Custom elements = a `group` of primitives/controls saved into `components` and
reused as instances.

## Operation schema (how edits are expressed)

Small, composable, numeric operations — the shared verb set for both GUI and Claude:

```jsonc
{ "op": "add",       "element": { ...full element... } }
{ "op": "delete",    "id": "el_1" }
{ "op": "move",      "id": "el_1", "dx": 20, "dy": 0 }          // or absolute x/y
{ "op": "resize",    "id": "el_1", "w": 140, "h": 40 }
{ "op": "set",       "id": "el_1", "path": "radius", "value": 12 }
{ "op": "copy",      "id": "el_1", "dx": 0, "dy": 48, "count": 3 }
{ "op": "reorder",   "id": "el_1", "z": 5 }
{ "op": "group",     "ids": ["el_1","el_2"], "name": "Row" }
{ "op": "align",     "ids": [...], "axis": "left|hcenter|right|top|vmiddle|bottom" }
{ "op": "distribute","ids": [...], "axis": "h|v", "gap": 12 }
```

## Feature roadmap

### Phase 0 — Measuring (DONE)
Screenshot capture + ruler grid, AutoCAD crosshair, point/area measuring, 90°/45°
snap, per-shape name/label/color, Select/edit/delete, show-numbers toggle, capture
timer, save annotated PNG, export measurement JSON, right-click undo while drawing.

### Phase 0.5 — Drawing aids (DONE 2026-07-07)
- **Snap to points**: cursor snaps onto existing vertices/points (yellow ring
  indicator); snapping onto the first vertex closes the polygon.
- **Typed distance** (AutoCAD-style): while drawing, type a number + Enter to
  place the next vertex at exactly that many px along the aim direction.
- **Equal-length segments**: "= length" checkbox forces each new segment to the
  first segment's length while drawing; **≡ Equalize** rebuilds a selected
  area's segments to the average length after the fact (straightens near-axis
  directions within 12° so parallels become parallel and closed shapes close
  exactly — compass-rule adjustment distributes any residual).

### Phase 1 — From measurement to editable elements
- **Start-mode chooser** (DONE 2026-07-07): on launch, pick *Screenshot*
  (capture + measure / redline) or *New canvas* (blank design, pick size) or
  *Load a design.json*. A new design starts empty. `🆕 New` reopens the chooser.
- **Canonical design document + round-trip** (DONE 2026-07-07): `buildExport()`
  now emits the full document (`canvas {width,height,background,bgColor}`, grid,
  shapes with metrics); `loadDesign()` restores it. Save via `{ } JSON`, reload
  via `📂 Load` (client file picker) — verified round-trip preserves geometry,
  names, closed state, grid. The design JSON is the single source of truth Claude
  reads/writes. Screenshot backgrounds aren't stored (raster); those reload onto
  a same-size blank canvas.
- State refactor (DONE): `state.image` → `state.ready` + `state.background`
  (null for blank canvas) + `state.bgColor`, so a document can exist with no
  screenshot.
- TODO next: split the toolbars by mode — screenshot mode keeps the pointing
  tools exactly as they are (points/areas are the whole point there); canvas
  mode drops them and gets the assets & shapes palette instead. Introduce the
  richer element model (rect/ellipse/widgets) and renderer for canvas mode.

### Phase 2 — Editing operations & shape tools
- **Rectangle & ellipse tools** (DONE 2026-07-07): canvas-mode drawing tools;
  drag to create, auto-named ("Rectangle 1"…), fill + stroke + corner radius
  from the toolbar, editable name/text. Rendered with fill/stroke/roundness and
  centered text; serialized to JSON (x/y/w/h/radius/fill/stroke + center) and
  restored by loadDesign.
- **Select → move & resize** (DONE 2026-07-07): in canvas mode, drag an
  element's body to move it; 8 resize handles (with matching resize cursors) to
  resize; hover shows move/resize cursors; Delete removes it. Mode-aware toolbar
  hides pointing tools in canvas mode and drawing tools in screenshot mode.
- **Ctrl+Click properties panel** (DONE 2026-07-07): floating, draggable, live
  two-way sync, ✕/Esc to close. Now organized into **collapsible sections**
  (Position & size / Appearance / Text / Name) with richer controls: **sliders**
  (border width, radius, font size — each with a value indicator), a **Filled**
  checkbox, and **Align H/V** selects for text/title placement, plus text color.
  Element props added: filled, fontSize, alignH, alignV, textColor (all
  round-trip through JSON). (px units only — px/% toggle still to do.)
- **Creation-mode bottom bar** (DONE 2026-07-07): grid + show-numbers controls
  relocate to a bottom bar in canvas mode (stage/canvas resizes to fit); top
  toolbar keeps file/mode/element ops. Will also host the command line + history.
- **Fixed-position property** (DONE 2026-07-07): `fixed` checkbox in the
  properties panel (pinned / absolutely-positioned metadata; shows 📌 on the
  element label; round-trips). Title/text placement (Align H left/center/right +
  Align V top/middle/bottom) already covered.
- **UI library defaults research** (DONE 2026-07-07): `libraries.md` documents
  GTK 4 and KDE spacing systems + per-widget default sizes/paddings/margins/radius
  for one-click defaults. **Assets/** folder set up (`Assets/SVGs/` ~117 icons)
  for the planned `icon`/`svg` element type — see `Assets/README.md`.
- **Element move snapping** (DONE 2026-07-12): canvas elements snap to the
  active grid and nearby element edges/centres with magenta alignment guides.
  Dropping with Select or Move into an active container assigns the real parent
  and slot, clears Fixed, and follows that layout. Absolute positioning requires
  explicitly enabling Fixed in Properties. Grid controls are available in the
  canvas bottom bar.
- **Icon elements + Library panel** (DONE 2026-07-07): server serves
  `Assets/SVGs/` (`GET /assets` list + `/assets/<file>`); a right-side **Library
  panel** (creation mode) lists the 117 icons with search + collapse; clicking
  inserts an `icon` element (SVG rendered on canvas, selectable/movable/resizable,
  round-trips by `src`). Verified end-to-end incl. a saved toolbar mockup.
- **Widget library** (DONE 2026-07-07): `type:"widget"` elements rendered as real
  controls — **button, textbox, label, checkbox, toggle, slider** — via a
  registry (`WIDGETS`) with **GTK 4 / KDE** per-toolkit default size/radius from
  `libraries.md`. Library panel has **Icons | Widgets** categories + toolkit tabs;
  clicking inserts with defaults. State (checked/on/value) renders and round-trips.
  Verified with a saved settings-form mockup.
- **More widgets + categories + editing** (DONE 2026-07-07): widget library now
  has collapsible categories **Sections / Input / Output / Backend** with Window,
  Section, Radio, Dropdown, Progress, Image, File, Storage added. **Depth
  (z-order)** with Front/Back; **Copy/Cut/Paste/Duplicate** (Ctrl+C/X/V/D); a new
  blank canvas seeds a **"Session" Window**; fixed the library category-hiding
  bug. **Flow chart → text** (`▤ Flow` → `_flow.txt`: windows + contained
  widgets). Fixed an `allVertices` crash on element shapes.
- **UI polish + XML** (DONE 2026-07-07): bottom-left **zoom % indicator**;
  properties open on **right-click** (canvas) and are **single-column**; **XML
  export** (`</> XML` → nested canvas>window>widget `.xml`; JSON stays canonical);
  the **root Window can't be deleted** (always one "Session"). Server `/save-text`
  now takes an `ext` (used for `.xml`).
- **Layout + toolkit windows + polish** (DONE 2026-07-08): GTK/KDE **window
  headerbar** (title + hamburger + window buttons, `buttonSide`); **opacity**
  (transparency) + **margin/padding** properties; creation-mode **bottom bar now
  holds the tools** (Select/Rect/Ellipse, Copy/Cut/Paste/**Delete**/Undo/Clear);
  **Section layout** (vertical/horizontal/table + align) with an **Arrange
  children** action (containers position their children; nesting via
  smallest-container parent).
- **Multi-select + group/ungroup + widget state** (DONE 2026-07-08):
  **multi-select** (`selection[]`) via **shift-click** and **marquee** (excludes
  the background window); multi-**move/delete/copy/cut/paste** on the whole
  selection (root Window still protected); **▣ Group** / **▢ Ungroup**
  (`Ctrl+G` / `Ctrl+Shift+G`); a **State** section edits stateful widgets
  (checked / on / value); widget text honors Align H/V.
  Alignment consistency fix (2026-07-15): Section and other specialized
  single-label renderers now share the same bounded H/V placement logic; the
  Properties panel shows each widget's real fallback instead of always showing
  center/middle. Editing alignment on an unfilled widget also preserves
  `fill: none` rather than silently changing it to black.
- **List widget (+count)** (DONE 2026-07-08): rows rendered with dividers; a
  **Rows** control in the State section sets `count`; round-trips.
- **Window-preset component inventory** (DONE 2026-07-12): added toolkit-sized
  **scrollbar, clock, calendar, menubar, and toolbar** widgets. They use the
  existing registry/insertion/layout/export model and are ready to compose into
  GTK/KDE window presets.
- TODO: vertical/horizontal **wrap** + gap prop for arrange; **interactive Preview mode**; **window states/frames**; **actions/connections**
  → richer flow chart; toolkit-specific XML (GtkBuilder/Qt `.ui`); **rotate**;
  **icons as button properties**; apply-toolkit-defaults button; light/dark icon
  auto-swap; `buttonSide` UI control; undo/redo stack.
- TODO: **rotation tool** (handle + numeric angle, snap to 15°/45°/90°).
- TODO: **arc** shape; copy/paste/duplicate (dx/dy + repeat count); z-order;
  lock; snapping to grid/other-element edges with distance guides; typed-distance
  generalized to move/resize; operation-based undo/redo.

### Phase 3 — Element library + properties (canvas mode)
- **Premade widget library shipped with the app** (designed by Claude, editable):
  button, textbox, label, toggle, checkbox, radio, slider, dropdown, card,
  tooltip, tab bar, scrollbar — each a component made of primitives, so Teo can
  restyle or derive his own.
- **Assets & shapes palette** (icon toolbar/sidebar) — the primary way to add
  things in canvas mode; every placed item automatically gets a name (editable)
  and exact position, so nothing needs to be "pointed at".
- Properties panel: position, size, **corner roundness**, fill, stroke, text,
  font size, **per-element notes**, and the element's **actions** list.
- Alignment & distribution tools.

### Phase 3.5 — Window table + connections view + auto flow chart
- **All windows visible on one canvas.** Add an empty toolkit window or deep-copy
  an existing window as another size/state. Add/rename/duplicate/delete roots.
- **Actions as data.** Elements (buttons, menu items…) declare named actions
  ("click", "submit"…) with a short description.
- **Connections view** — a separate view where every window appears as a
  labeled box listing its buttons/actions; drag from an action to a window to
  declare "this action opens that window" (or to an *effect* node for
  non-navigation results like "saves file"). Stored in `connections[]`.
- **Auto flow chart output.** Rendered from windows + connections with an
  auto-layout — viewable in-app and exportable (PNG/SVG + JSON). Since it's
  derived from data, it's always in sync with the design; Claude can read the
  full navigation flow of the app from `design.json` alone.

### Phase 4 — Custom components
- Group primitives → **save as a component** into a library.
- Insert component instances; edit instance overrides.
- Component library persisted with the document (or a shared library file).

### Phase 5 — Command line + Claude integration (the "commands")
- **5a — AutoCAD-style command line (DONE 2026-07-08)**: `cmd:` input in the
  bottom bar. Grammar (one shared verb set — `runCommand(str)` is the single
  entry point, so the GUI bar, HTTP, and Claude all speak it; every call lands
  in `cmdLog`, the replayable operation log):
  `add <widget|rect|ellipse|window> [into <container>]` ·
  `set <el> <prop>[.<side>] <value>` · `move <el> <dx> <dy>` ·
  `move <el> into <container> [<slot>]` · `resize <el> <w> <h>` · `del` ·
  `copy <el> [n]` · `rename` · `select` · `arrange` · `theme <name>` ·
  `list` (indented tree) · `help`. Elements resolve by id, exact name, or
  name prefix. ↑/↓ recalls history; a popup above the bar lists past commands
  (click to reuse; failures shown in red).
- 5b: continuous `design.json` autosave to a repo path; app hot-reload on change.
- 5c: HTTP command API. First live slice complete (2026-07-15): localhost queue,
  open-editor polling through the shared `runCommand()`, result retrieval, and
  `scripts/pixelruller_command.py`. Remaining: `/design`, batch `/ops`, and hot
  reload/autosave integration.
- 5d: operation log / history so both sides' edits are reviewable and replayable.

### Phase 6 — Design ↔ code binding
- [x] **Runnable HTML/CSS export (2026-07-15):** the canonical parent/slot tree
  generates nested DOM and native controls; fixed/fill/hug/percentage sizing,
  grow, alignment, padding/margin/gap, min/max, wrapping, overflow, visual style,
  state and embedded assets produce one self-contained HTML file. Only explicit
  Fixed children generate absolute positioning. PDFExtractor verified at
  65/35 and 50/25/25 in the generated browser output.
- Per-element `code` binding (component name, file, selector).
- Export a **change-spec**: a diff of design ops mapped to the bound code targets,
  so Claude applies numeric changes to the actual source precisely.
- Optional: import current code layout back into the design for round-tripping.

### Phase 7 — Polish
- Layers/outline panel, multi-select marquee, keyboard nudging, rulers/guides,
  zoom-to-selection, export to PNG/SVG, theming.

## Architecture decision: stay web + local Python server (2026-07-07)

**Question:** is the web direction right, or should we switch stacks?

**Decision: keep it.** Reasons:

- **It fits the machine.** This system has no Python GUI toolkit, no pip, no
  node — the stdlib-server + browser-canvas stack is the only zero-install
  option, and it already works.
- **Canvas is the right renderer** for a 2D numeric design tool: exact pixel
  drawing, cheap hit-testing, trivial PNG export at true resolution — the same
  drawing code runs on screen and in saved images today.
- **The server is the integration point.** The same local HTTP server that
  serves the GUI becomes the command API (`/design`, `/ops`, `/cmd`) that
  Claude and a terminal REPL use. A native toolkit app would need all that
  built separately.
- **Wayland favors it.** Native transparent click-through overlays are
  restricted under Wayland; measuring on a captured still sidesteps that
  entirely, and `spectacle` handles capture.
- **Known limits, all acceptable:** no global hotkeys inside the browser (KDE
  shortcuts → `run.sh` cover it), browser chrome around the app (can launch
  Chrome `--app=URL` kiosk-style for a native feel), and if we ever want a real
  windowed app, `pywebview` wraps this exact codebase without a rewrite.

**Revisit if:** we need multi-window tool palettes, GPU-heavy rendering, or
drag-and-drop with other desktop apps. None are on the roadmap through Phase 7.

## Open questions / decisions to make

- ~~Blank canvas vs. redline-over-screenshot~~ **DECIDED 2026-07-07: they are
  separate modes with separate toolsets.** Screenshot mode = pointing/measuring
  (communication → numbers). Canvas mode = placing named assets (design). No
  pointing tools in canvas mode; no asset palette in screenshot mode.
- ~~One document vs. multiple pages/artboards~~ **UPDATED 2026-07-15: multiple
  root windows and their variants remain visible together** in one window table,
  plus a connections view that turns windows + actions into a flow chart.
- ~~Coordinate space~~ **DECIDED 2026-07-08: slot-first layout** (see
  "Layout-first canvas"). Position = slot in a container + toolkit spacing;
  absolute px only via per-cell `fixed`.
- **Element→code binding format** — how expressive (single selector vs. full
  prop mapping)? Start minimal.
- **Where `design.json` lives** — per-project in the repo so Claude sees it in
  context, vs. the `PixelRuller` folder. Leaning repo.
- **Effect nodes in the flow chart** — how rich? Start with plain-text effects
  ("saves file"); maybe typed effects (dialog, toast, state change) later.

## Notes / parking lot

- Screenshot mode stays as-is by design — points/areas exist to point things
  out and convert intent to numbers so Claude needs no photos.
- The measurement JSON export already proves the "design as data" pipe works
  end-to-end; Phase 1 generalizes its schema into the element model above.
- `Map.md` documents every file and function — update it when code changes so
  either of us can orient quickly.
