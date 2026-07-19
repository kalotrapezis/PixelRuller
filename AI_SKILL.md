# PixelRuller AI Usage Guide

This plain Markdown guide is platform-neutral. Give it to any AI that will create,
edit, inspect, or implement a PixelRuller design. PixelRuller is a shared visual
design surface, not a programming language or application-behavior engine.

## Access after installation

The Debian package installs the launcher as `/usr/bin/pixelruller`, so the app is
available to every normal user through the application menu and shell `PATH`.
Administrator permission is required only to install or remove the package.

An AI does not need root access to use PixelRuller. It needs:

- permission from its host to run `pixelruller` if it must start the app;
- optional browser access for final visual inspection or for editor operations
  that do not yet have command equivalents;
- read/write access to the project design JSON if it will update that file.

Screenshot capture additionally requires a graphical desktop session and any
supported screenshot tool. PixelRuller auto-detects Spectacle, GNOME/MATE/XFCE
Screenshot, Grim, Flameshot, Scrot, Maim, or Shutter, and accepts a custom
`PIXELRULLER_SCREENSHOT_COMMAND` containing `{output}`. Canvas design, JSON
loading, commands, and code export do not need screenshot permission. Prefer the
design command bar and canonical JSON over pointer-driven editing. An AI without
browser control can still read, edit, and implement exported JSON; only live
visual verification requires access to the rendered editor or preview.

Useful installed commands:

```text
pixelruller                         Start and open the app
pixelruller --no-open               Start without opening a browser
pixelruller --port 8765             Use a known local port
pixelruller --grid                  Start in screenshot/grid mode
pixelruller --version               Print the installed version
pixelruller --screenshot-backends   List detected screenshot tools
pixelruller --ai-skill-path         Print this guide's installed path
pixelruller --print-ai-skill        Print this complete guide
```

A reliable AI-controlled session is:

```text
pixelruller --no-open --port 8765
```

Then open `http://127.0.0.1:8765/` in a browser-control surface. The command bar
inside PixelRuller is a design command bar; its commands are not shell commands.

## Non-negotiable design rules

1. The canonical PixelRuller JSON is the source of truth for the interface.
2. Preserve hierarchy, slot order, sizes, percentages, spacing, colors,
   typography, alignment, borders, states, widget names, and window variants.
3. Every visible design property must round-trip through JSON and translate into
   implementation code. Do not use editor-only layout illusions.
4. Prefer nested Sections and relative layout. Use `fixed: true` only when the
   approved design deliberately needs absolute positioning.
5. Business logic, file pickers, validation, navigation, and runtime commands
   belong in the real application code. PixelRuller describes the controls.
6. Do not infer unusual behavior from appearance alone. Use the user's brief or
   the target application's existing behavior.
7. Reload and visually inspect a design after material changes, including at
   more than one window size.
8. Apply the selected toolkit's metrics before approving a design. Never remove
   internal control padding to make text fit; shorten the label, widen the
   control, or move secondary wording into a nearby title/subtitle.

## Widget catalogue

Use semantic widgets instead of decorative rectangles whenever one exists.

| Category | Widget command names |
|---|---|
| Sections | `window`, `section`, `splitpane` |
| Input | `button`, `textbox`, `checkbox`, `radio`, `toggle`, `slider`, `dropdown`, `scrollbar` |
| Navigation | `menubar`, `toolbar`, `menuitem`, `toolbutton`, `separator`, `spacer`, `tabs`, `wincontrols`, `titlebar`, `statusbar`, `breadcrumb`, `searchfield` |
| Output | `label`, `image`, `progress`, `list`, `clock`, `calendar` |
| Backend/logical | `file`, `storage` |

`rect`, `ellipse`, `icon`, and user-made `composite` elements also exist. Backend
widgets express an implementation dependency; they do not implement storage.

Assets: buttons/tool buttons/menu items/textboxes take an `icon`; the `image`
widget takes a `src` that letterboxes inside its frame. Both accept built-in
`SVGs/<name>.svg` entries or the user's own files dropped into
the `assets/` folder inside the output dir — `<app>/output/assets/`, or
`~/PixelRuller/output/assets/` on read-only installs (PNG/SVG/JPG/WebP), referenced as
`user/<file>` — e.g. `set Image src user/logo.png`. List them with the
`assets [filter]` command (e.g. `assets chevron`, `assets user`) or
`GET /assets`; copying a file into the drop folder makes it available
immediately, and the editor's "📂 Choose an asset…" picker uploads through
`POST /assets/upload` (name collisions get a `_2` suffix automatically).

**Use the provided SVGs first, and match their style when you add your own.**
List the built-in set (`assets [filter]` / `GET /assets`) before inventing an
icon — it is broad (arrows, chevrons, gear, search, files, lock/unlock, face-id,
media, brush, trash, warning, users, …). When a needed icon genuinely isn't
there, **author a new SVG in the same house style** rather than pasting a
mismatched third-party icon or dropping an emoji where a line icon belongs:
`viewBox="0 0 24 24"`, `fill:none`, a single stroke in `currentColor` (so it
follows the theme), `stroke-width="2"`, round `stroke-linecap`/`stroke-linejoin`.
Drop it into the output dir's `assets/` folder and reference it as `user/<file>`.
Keep every icon in the UI one coherent family — consistent weight, rounding, and
metaphor.

## Hierarchy and grouping

- `window` is a root container. At least one root must remain.
- `section`, `splitpane`, `menubar`, `toolbar`, `titlebar`, and `composite` can
  own children where appropriate.
- `parent` stores the owner's id; `slot` stores sibling order.
- Build complex regions as Sections inside Sections.
- Use `make-widget` only for a reusable editable visual composite. Use a Section
  for ordinary layout grouping.
- Managed children follow their parent's layout. Their computed `x`/`y` are
  outputs of hierarchy and layout, not the primary responsive intent.

Container layout values are `vertical`, `horizontal`, `table`, or `none`.
`none` means manual placement. Important responsive fields are:

```text
layout, align, gap, wrap, cols, overflow
padding.{t,r,b,l}, margin.{t,r,b,l}
sizeModeX, sizeModeY: fixed | fill | percent | hug
widthPercent, heightPercent, grow
minW, maxW, minH, maxH, colSpan, rowSpan
```

Use percentage sizing for ratios such as 50/25/25. Use `grow` to distribute
remaining space. Use `fill` to take available space and `hug` to follow content.

## Multiple windows and responsive stages

All root windows remain visible together in a vertically stacked window table.
They may be separate application windows or different sizes/states of the same
interface. The floating `+` asks for either:

- **Duplicate existing**: deep-copies the complete widget tree, remaps ids and
  parent links, preserves semantic child names, and reflows it at a new size.
- **New empty window**: creates editable GTK or KDE window chrome and an empty
  content container.

Use duplicates to show compact/regular/wide sizes or stages such as empty,
loading, error, and complete. A copied root records:

```text
variantOf      id of the original variant family
variantLabel   human-readable size or state name
```

Do not replace this workflow with editor tabs that hide the other stages: their
simultaneous visibility is deliberate for human/AI comparison.

## Command bar reference

Names containing spaces must be quoted. An element reference may be an id, an
exact name, or an unambiguous name prefix.

```text
help
new canvas <w> <h>
assets [filter]
tree [root] [all]
list [root] [all]
inspect <element>
selection
ui <hide|show|toggle>
add <widget> [into <container>] [with <prop> <value> …]
add rect [x y w h] [into <container>]
add ellipse [x y w h] [into <container>]
add window empty [gtk4|kde] [w] [h] [name]
add window copy <source> [w] [h] [name]
set <element> <property>[.<side>] <value>
move <element> <dx> <dy>
move <element> into <container> [slot]
resize <element> <w> <h>
del <element>
copy <element> [count]
cut <element>
paste
rename <element> <new name>
select <element> [<element> …]
select add <element>
select none
front <element>
back <element>
group [name]
style copy <element>
style apply [<element> …]
defaults <element> [gtk4|kde]
arrange <container>
make-widget [name]
enter <composite>
exit
ungroup <composite|section>
theme <GTK light|GTK dark|KDE light|KDE dark>
```

`select` with several references builds a multi-selection (quote names that
contain spaces); `group` wraps the selection in a Section; `front`/`back`
change z-order; `cut`/`paste` move whole subtrees through the clipboard;
`style copy`/`style apply` transfer an element's visual style; `defaults`
reapplies the documented toolkit metrics and registry style to a subtree
without changing text, names, state, or Window dimensions.

When the local editor is open on port 8765, submit the same commands without
mouse or keyboard simulation:

```text
pixelruller-command 'select "Apply changes"'
pixelruller-command 'tree "AppLocker Settings Compact" all'
pixelruller-command 'ui hide'
```

For bulk construction, pass `-` to read one command per stdin line; the whole
batch is queued together and executes at engine speed (about 50 commands per
second), printing one ✓/✗ result line per command:

```text
pixelruller-command - <<'EOF'
new canvas 1400 900
add window empty gtk4 1200 760 Settings
add section into Settings with name Sidebar layout vertical gap 2 sizeModeX fixed w 300 sizeModeY fill
add label into Sidebar with name "Sidebar title" text Settings grow 1 alignH center
EOF
```

`add … with` accepts any `set`-valid property plus `name` and `slot`; pairs are
validated before the element is created, so a bad pair adds nothing. The `add`
result carries the new element's `id` and final `name` in its `data` field —
use those for follow-up commands instead of parsing the message text.

`tree` reports hierarchy, ids, slots, geometry, fill/stroke, visibility, managed
versus fixed layout, and marks the current selection with `▶`. `inspect` returns
the complete stored element plus current visibility and children. `ui hide`
temporarily suppresses editor chrome and canvas number labels; `ui show` or
Ctrl+Shift+U restores the previous view.

Examples:

```text
add section into Content
rename Section "Output controls"
set "Output controls" layout horizontal
set "Output controls" gap 12
set Progress sizeModeX percent
set Progress widthPercent 50
move Progress into "Output controls" 0
add button into "Output controls"
set Button text "Extract PDFs"
add window copy Session 720 540 "Compact complete"
add window empty kde 900 640 "Preferences"
theme KDE dark
```

`set` accepts stored properties, including dotted spacing sides such as
`padding.t`, `padding.r`, `margin.b`, and `margin.l`. Boolean text is parsed as
`true`/`false`; numeric text becomes a number. The command history can replay
previous operations with the up/down arrow keys.

## Canonical JSON

Top-level fields:

```text
app, version, mode
canvas: width, height, background, bgColor
grid: on, spacing_px
count
shapes[]
```

Common shape fields:

```text
type, id, parent, slot, name
x, y, w, h, fixed, z
sizeModeX, sizeModeY, widthPercent, heightPercent, grow
minW, maxW, minH, maxH, colSpan, rowSpan
fill, stroke, strokeWidth, opacity, radius
text, fontSize, textColor, alignH, alignV
margin, padding
```

Widget-specific fields include `widget`, `toolkit`, `layout`, `align`, `gap`,
`cols`, `wrap`, `overflow`, `checked`, `on`, `value`, `active`, `controls`, icon
fields, scroll fields, and window variant metadata. Visual-fidelity fields:
`strokeStyle` (`solid|dashed`), per-side `borderSides.{t,r,b,l}` booleans
(GNOME row dividers = bottom-only), caption-in-border via
`captionMode border` + `captionSide top|bottom` + `captionAlign
left|center|right` (exports as a legend, maps to GtkFrame/QGroupBox),
`bold`/`italic`/`fontFamily`, `shadow`, and `showText` (`false` hides a
widget's label and its placeholder fallback without deleting the stored text). Declarative UI behavior on
controls: `action` (`toggle|show|hide|switch`) + `target` — `switch` shows the
target section and hides its sibling sections; in the editor these fire on
**Shift+Click** (a plain click only selects) and they work in the exported
HTML runtime. A section with `modal true` floats above its whole window on a
dark scrim when visible — use it for hamburger menus and gear/settings dialogs
instead of a second window. Give it `anchor <element>` to pin it under its
trigger (e.g. the hamburger button); with no anchor it centres in the window.
Shift+Click outside an open modal dismisses it. In **Demo mode** (`demo on|off`,
or the ▶ Demo button) plain clicks fire interactions, controls flip their own
state (toggle/checkbox/radio/slider/tabs), an `action` whose target is another
window pans the camera there (flow navigation), and nothing is editable — use
it to click through a prototype. Designs also carry **notes**: `doc.notes`
in the JSON, each with element-id tags — read them with `note list` (they often
hold the designer's intent for you) and leave notes with
`note add "text" [element …]`. Keep real application logic in code. Compare revisions by `id`,
`name`, `parent`, and `slot`, not only by computed coordinates.

JSON is the canonical editable format. Nested XML, flow text, PNG, and runnable
HTML are exports for inspection or implementation; they do not replace JSON.

## Toolkit guidelines and palettes

PixelRuller currently supports GTK 4/GNOME and KDE/Kirigami/Breeze. Windows
Modern UI and macOS guidance are future additions and must not be invented from
these Linux presets.

Official guidance supplies the spacing systems and design principles. Exact
per-widget pixel sizes and these practical role palettes are PixelRuller-derived
defaults for reproducible design work; they are not claims that every value is
an immutable official toolkit token.

Treat these as build constraints:

- Use GTK multiples of 6 and KDE/Kirigami semantic spacing units consistently.
- Give GTK text buttons 12 px horizontal and 6 px vertical internal padding;
  use the toolkit metric even when the button is set to hug content.
- Give KDE text buttons the derived 8 px horizontal and 4 px vertical padding.
- Keep adjacent action buttons the same height and, where practical, the same
  width. GNOME recommends equal widths for neighboring buttons.
- Use short imperative labels such as `Apply`, `Edit Faces`, or `Stop`. Put
  explanation in a nearby title/subtitle rather than squeezing it into a button.
- Use a switch for immediate settings and a checkbox when changes wait for an
  Apply/OK action. Do not use a switch as a decorative status marker.
- When a switchable row has additional configuration, follow the GNOME Settings
  pattern: place a round flat gear `toolbutton` (⚙, icon-only, no fill/border)
  immediately before the switch, so all switches stay aligned at the row's
  trailing edge. The gear opens the
  row's detail dialog or subpage. Do not add a separate text button such as
  `Edit …` inside the card for the same purpose.
- Treat every switch as three theme roles: a neutral **thumb**, a neutral
  **off track**, and an accent/highlight **on track**. The thumb never takes
  the track's state color; the track communicates off versus on.
- For GTK/GNOME, follow the native switch/theme tokens. The official light
  example uses a white thumb in both states, a neutral-gray off track, and the
  accent color for the on track. Dark values are toolkit-derived rather than a
  mechanical inversion; the official dark example uses a light thumb.
- For KDE/Breeze, use `Kirigami.Theme.backgroundColor` for the handle, a neutral
  background/text blend for the off track, and `Kirigami.Theme.highlightColor`
  for the checked track/border. Preserve native high-contrast behavior.
- Use theme roles and toolkit widgets instead of custom hardcoded colors whenever
  the final implementation supports them.

Spacing baseline:

| Role | GTK/GNOME | KDE/Kirigami |
|---|---:|---:|
| Small | 6 px | 4 px |
| Medium | 12 px | 6 px |
| Large | 18 px | 8 px |
| Content/window margin | 12 px | 8–12 px |
| Label/control gap | 12 px | 6 px |

Theme role order is background, surface, view, border, text, muted, accent,
accent hover/highlight, success, warning, error.

| Theme | bg | surface | view | border | text | muted | accent | accentHi | success | warning | error |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GTK light | `#fafafa` | `#ffffff` | `#ffffff` | `#d5d0cc` | `#3d3846` | `#77767b` | `#3584e4` | `#1c71d8` | `#26a269` | `#e5a50a` | `#c01c28` |
| GTK dark | `#242424` | `#303030` | `#1e1e1e` | `#1b1b1b` | `#ffffff` | `#9a9996` | `#78aeed` | `#62a0ea` | `#33d17a` | `#f8e45c` | `#ff7b63` |
| KDE light | `#eff0f1` | `#fcfcfc` | `#ffffff` | `#bdc3c7` | `#232629` | `#7f8c8d` | `#3daee9` | `#93cee9` | `#27ae60` | `#f67400` | `#da4453` |
| KDE dark | `#31363b` | `#2a2e32` | `#232629` | `#4d4d4d` | `#eff0f1` | `#a1a9b1` | `#3daee9` | `#93cee9` | `#27ae60` | `#f67400` | `#da4453` |

Sources:

- GNOME Human Interface Guidelines: https://developer.gnome.org/hig/
- GNOME switches: https://developer.gnome.org/hig/patterns/controls/switches.html
- GNOME buttons: https://developer.gnome.org/hig/patterns/controls/buttons.html
- Libadwaita styles and high contrast: https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/styles-and-appearance.html
- GNOME layout archive: https://wiki.gnome.org/Design/HIG/Planning/Layout
- KDE Human Interface Guidelines: https://develop.kde.org/hig/
- KDE input controls: https://develop.kde.org/hig/getting_input/
- KDE layout and navigation: https://develop.kde.org/hig/layout_and_nav/
- KDE units and measurements: https://develop.kde.org/hig/layout/units.html
- Kirigami Units reference: https://api.kde.org/kirigami-platform-units.html
- KDE Breeze switch indicator: https://invent.kde.org/frameworks/qqc2-desktop-style/-/blob/master/org.kde.desktop/private/SwitchIndicator.qml

See `libraries.md` in the project for the full derived widget metrics and source
notes.

## Theme-following colours (design hex → real app code)

The canvas palettes above give every accent-role element a concrete hex (e.g. the
GTK-light accent `#3584e4`) so the mockup reads faithfully. **When you generate
the real application code, do not emit those accent hexes.** Map each colour to a
theme token or style class instead, so the built app follows whatever accent and
light/dark the user has chosen (blue, pink, teal…) — the same "no hardcoded
colours, no CSS fighting the theme" rule the native example apps already follow.

Which colours to translate, and which to keep:

- **Translate** anything on an *accent role* (primary buttons, the on-track of a
  switch, progress fill, a drop-zone's border/text, links/accent text, selection).
- **Keep the design hex** only for *semantic status* tints (success/warning/error)
  and neutral surfaces where the theme has no matching token — and even then
  prefer a translucent tint (`alpha(#hex, 0.16)`) so it survives dark mode.

### GTK 4 / GNOME

Prefer built-in **style classes** over colour references — they already carry the
theme accent and its correct foreground:

| Design element | Emit (class / behaviour) — not a hex |
|---|---|
| Primary / accent button | `.suggested-action` |
| Destructive button | `.destructive-action` |
| Card / surface panel | `.card` |
| Big title | `.title-1` … `.title-4` |
| Subtitle / caption / status text | `.dim-label` |
| Section heading | `.heading` |
| Progress bar fill | nothing — `Gtk.ProgressBar` fills in the theme accent automatically |
| Rounded/pill button | add `.pill` |

When custom CSS genuinely needs the accent colour (a dashed drop-zone border,
accent-coloured text on a tinted panel), reference the classic named colour
**`@theme_selected_bg_color`** (accent/selection background) and
**`@theme_selected_fg_color`** (text on it).

> ⚠️ Do **not** use `@accent_bg_color` / `@accent_color`. Those are
> libadwaita-only names; stock GTK themes such as **Mint-Y** do not define them,
> so the reference silently fails in an app-level `CssProvider` and the element
> renders faint or default. `Gtk.StyleContext.lookup_color("accent_bg_color")`
> also returns *not found* on those themes. `@theme_selected_bg_color` is defined
> by essentially every GTK theme and is the reliable choice.

Keep any custom CSS to **geometry only** — `border-radius`, `padding`,
`min-height`. Load it at `GTK_STYLE_PROVIDER_PRIORITY_APPLICATION` so it layers
over the theme without overriding its colours.

### KDE / Kirigami / Breeze

Use theme roles, never hex: `Kirigami.Theme.highlightColor` for the accent
(buttons' checked/selection state, progress, drop-zone border),
`Kirigami.Theme.textColor` / `Kirigami.Theme.backgroundColor` for content, and
the native controls (`Button` with a highlighted role, `Kirigami.Card`) so the
Breeze accent and colour scheme apply automatically.

### Worked example — the PDFExtractor design

The `PDFExtractorUI.json` mockup used `#356fe0` for the Extract/Browse buttons and
a blue drop-zone. The generated GTK 4 code emits **no** blues: the buttons get
`.suggested-action`, the progress bar is left unstyled, and the drop-zone's dashed
border and label use `@theme_selected_bg_color`. Switching the desktop theme from
blue to pink recolours the whole app with zero code changes.

### Native layout & UX patterns (design cues)

Colour is only half of "follow the platform". A GTK/GNOME target is also expected
to reproduce these layout conventions — the AppLocker and GNOME Settings example
designs are the reference. Don't emit a flat wall of controls.

- **Gear before a switch = per-row settings.** When a switch/toggle governs
  something that has its own further settings, place a round **flat gear
  toolbutton** (⚙, icon-only, no fill, no border) immediately **before** the
  switch. It opens the detail dialog/subpage for exactly the thing that switch
  controls, and keeps every switch aligned at the row's trailing edge. Do **not**
  add a separate `Edit…` text button for this — the gear *is* the affordance.
  (Maps to a flat `GtkButton` with an icon, or an `Adw.ActionRow` with a gear
  suffix plus the switch. KDE: a flat configure-icon `Button` before the `Switch`.)
- **Bordered section cards.** Group related rows inside a bordered section — the
  GNOME boxed list (`.boxed-list`) or `.card`: one rounded outer border with
  **bottom-only** 1px dividers between rows (`borderSides` bottom only). Never
  leave controls floating on the bare window background. (KDE: a `Kirigami.Card`
  or `Kirigami.FormLayout` with a visible boundary.)
- **Titles and subtitles explain the UI.** Every section carries a heading
  **title** and a **subtitle/description**, and each row can carry its own title
  plus a dim subtitle. The UI/UX explanation lives in these
  (`.heading` / `.title-*` / `.dim-label`, or an `Adw.PreferencesGroup`
  title+description) — never crammed into a control's label. This is what makes
  the interface self-explaining.
- **Row layout.** A settings row reads left→right: leading title (+ optional dim
  subtitle), a growing spacer, then the trailing control cluster (optional gear,
  then the switch/value/chevron), right-aligned and consistent across rows.
- **Sidebar + page stack, not tabs.** Separate top-level content into logical
  sections with a **sidebar** — a vertical list of destinations — driving a page
  **stack**, not a tab bar. Each sidebar item's `action: switch` + `target` shows
  its page and hides the siblings (one `section` per page in a "Page stack").
  Pin low-priority items (version, About) to the bottom of the sidebar with a
  growing **spacer** above them. Maps to `Adw.NavigationSplitView` /
  `GtkStackSidebar` + `GtkStack` (KDE: `Kirigami.PageRow` / `GlobalDrawer`).
  Reserve **tabs** for peer documents/views *within* a page, never for the app's
  top-level sections.
- **Commit action bar.** A screen that batches changes behind Apply/OK gets a
  bottom action bar: a growing spacer pushes buttons to the trailing edge, a
  secondary/destructive button (Revert/Cancel) left of the primary (Apply);
  equal heights, `.suggested-action` on the primary, `.destructive-action` where
  the action discards work.
- **Modal dialogs, not windows.** A task that must be finished or dismissed
  before continuing (enroll, rename, enter a PIN, confirm) is a **modal dialog**
  that dims/darkens the parent behind a **scrim** — not a separate top-level
  window, not an inline panel. The dimmed backdrop signals "finish this or close
  it." Title + body + a bottom action bar (Cancel leading, primary trailing).
  Maps to `Adw.Dialog` / `Adw.MessageDialog` (or a modal `GtkWindow` set
  `transient-for`); KDE `Kirigami.Dialog`. In a *mockup* these appear as separate
  window shapes only because the canvas has no overlay layer — implement them as
  a modal over the parent.
- **Responsive variants.** Ship compact + regular variants of a screen. On narrow
  widths the sidebar folds from a permanent column into a toggle/drawer and rows
  reflow — nothing is clipped. Use `hideBelow`/`showBelow` to express what swaps
  at a breakpoint; maps to Adw breakpoints / `Adw.OverlaySplitView`.
- **Header back-navigation.** Drilling into a **subpage** adds a Back button at
  the leading edge of the header bar to pop to the parent (`Adw.NavigationView`
  push/pop). Sidebar = lateral top-level moves; header Back = depth within a
  section.
- **Colour as status/type.** Colour-code list rows by type or state so the
  category reads at a glance — the PDFExtractor design tints file rows by
  processing state: ready/fast = a translucent **success**-green tint (fill +
  border + text, same hue) with a ⚡ glyph, needs-OCR/slow = a **warning**-amber
  tint with a 🐌 glyph. Keep tint/border/text in one hue family, draw from
  success/warning/error as a translucent tint (α≈0.12–0.16) so it survives dark
  mode, and **always pair colour with a glyph and text — never colour alone**
  (colour-blind readers). Maps to a `.card` row with a per-state class tinting
  `@success_color`/`@warning_color`/`@error_color`.
- **Content + inspector split.** A work area plus its options is a horizontal
  split: primary content pane leading (~65%), a narrower settings/inspector pane
  trailing (~35%), each a white card. This is *not* navigation (that's the
  sidebar) — it's content beside its settings. `Adw.OverlaySplitView` / `GtkPaned`.
- **Drop zone with a fallback.** A drag target is an accent-tinted panel — accent
  fill, accent (often dashed) border, accent instructional text — **plus** an
  explicit "…or click Add files" button. Never drag-only; drag isn't discoverable
  or accessible. Border/text via `@theme_selected_bg_color`.
- **Clean surface hierarchy.** The clean look = a softly tinted workspace
  background, white content cards raised on it with a soft 1px border and ~14px
  radius, and roomy 20–28px padding with comfortable row gaps. Whitespace does
  the work — don't pack controls edge-to-edge.
- **Rounded corners follow a scale.** Not one radius everywhere — by role: window
  ≈12, cards/sections ≈12–14, controls (buttons, textboxes, dropdowns) ≈8,
  chips/list rows ≈6, progress bars & checkboxes ≈4, toggles/pills fully rounded
  (`height/2`). KDE/Breeze is tighter (cards ≈4–6, controls ≈3–4). **Nesting
  rule:** a child's radius is ≤ its container's (inset by ~the padding), so a
  child never looks rounder than the card holding it; and reuse the *same* radius
  for the *same* role across the UI. These are geometry-only `border-radius`
  values — fine in custom CSS, chosen to sit with the theme's own rounding.
- **Self-narrating microcopy.** The primary button states the concrete effect and
  count ("Extract 3 PDFs"); a nearby status line gives readiness + estimate
  ("Ready · estimated OCR time 18 minutes"); summaries pack facts with middot
  separators ("3 files · 248 pages · 2 fast · 1 needs OCR"). Fill from real state.

These cues ship **inside every exported design** as `aiTheme.<toolkit>.patterns`,
so an AI handed only the JSON still reproduces them — no need to have read this
guide first.

## Human and AI workflow

Before editing, read this guide, the project README/Map, the canonical JSON, and
the target application's existing code. Then:

1. Open the canonical design through Load or `?design=filename.json`, or start
   a fresh design from the terminal with `new canvas <w> <h>`.
2. Inspect names/hierarchy with `tree`; use commands for selection, property
   edits, movement, re-parenting, grouping, and arranging whenever possible.
   Keep pointer-driven editing for cases the command surface cannot express.
3. Make semantic, named changes with widgets and nested containers.
4. Create visible size/state variants when responsiveness matters.
5. Export JSON and save it back to the canonical project path without removing
   unrelated user changes.
6. Reload the JSON and inspect the editor visually.
7. Translate the approved hierarchy and properties into real application code.
8. Test the implementation at every represented window size/state.
9. Give the user a direct clickable/downloadable chat link to every approved
   design artifact they need (at minimum the canonical JSON, plus generated code
   or package when applicable). Never report only a filesystem location after a
   co-design session.
10. Report the design file, code changes, visual checks, and any unavoidable
   implementation difference.

Completion means the approved visual state survives JSON reload, responsive
layout works at multiple sizes, behavior remains in application code, and both
the human and AI can continue from the same design file. The handoff is not
complete until the user has a clickable artifact link in the chat.
