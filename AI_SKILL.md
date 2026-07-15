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
tree [root] [all]
list [root] [all]
inspect <element>
selection
ui <hide|show|toggle>
add <widget> [into <container>]
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
rename <element> <new name>
select <element>
arrange <container>
make-widget [name]
enter <composite>
exit
ungroup <composite|section>
theme <GTK light|GTK dark|KDE light|KDE dark>
```

When the local editor is open on port 8765, submit the same commands without
mouse or keyboard simulation:

```text
pixelruller-command 'select "Apply changes"'
pixelruller-command 'tree "AppLocker Settings Compact" all'
pixelruller-command 'ui hide'
```

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
fields, scroll fields, and window variant metadata. Compare revisions by `id`,
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
- Use the theme's neutral/foreground handle color for switches. Do not hardcode
  a black or white knob as a universal GTK/KDE rule; preserve theme and
  high-contrast compatibility.
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
- GNOME buttons: https://developer.gnome.org/hig/patterns/controls/buttons.html
- Libadwaita styles and high contrast: https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/styles-and-appearance.html
- GNOME layout archive: https://wiki.gnome.org/Design/HIG/Planning/Layout
- KDE Human Interface Guidelines: https://develop.kde.org/hig/
- KDE input controls: https://develop.kde.org/hig/getting_input/
- KDE layout and navigation: https://develop.kde.org/hig/layout_and_nav/
- KDE units and measurements: https://develop.kde.org/hig/layout/units.html
- Kirigami Units reference: https://api.kde.org/kirigami-platform-units.html

See `libraries.md` in the project for the full derived widget metrics and source
notes.

## Human and AI workflow

Before editing, read this guide, the project README/Map, the canonical JSON, and
the target application's existing code. Then:

1. Open the canonical design through Load or `?design=filename.json`.
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
