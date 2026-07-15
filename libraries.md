# UI Library defaults — GTK 4 (GNOME) & KDE

Researched defaults for the two starter toolkits, so PixelRuller can apply the
**correct paddings, margins, sizes, spacing and corner radius with one click**
when you insert a widget or press "apply library defaults".

Spacing systems below are taken from the official guidelines (see Sources). The
per-widget pixel sizes are reasonable **derived defaults** built on those spacing
systems — refine as we test against real apps. Values are in px at 1× scale.

## Spacing systems (cited)

| Token | GTK 4 / GNOME | KDE (Kirigami/Breeze) |
|-------|---------------|------------------------|
| Base unit | 6 px (use multiples: 6/12/18/24) | `gridUnit` ≈ font height (~18 px) |
| Small spacing | 6 px (related controls) | `smallSpacing` = 4 px |
| Medium spacing | 12 px | `mediumSpacing` = 6 px |
| Large spacing | 18 px (groups) | `largeSpacing` = 8 px |
| Window/content margin | 12 px (content ↔ window border) | 8–12 px |
| Label ↔ control gap | 12 px | 6 px |

GNOME multiples of 6 (6/12/18/24) and a 12 px window margin; KDE derives spacing
from the font: `smallSpacing = floor(gridUnit/4)`, `largeSpacing = smallSpacing*2`.
Don't hard-rely on the gridUnit↔spacing ratio — it changes with the user's font.

## Per-widget defaults

Each entry: **w×h**, inner **padding**, outer **margin**, **radius**, plus notes.

### GTK 4 / GNOME (libadwaita)

| Widget | w×h | padding | margin | radius | notes |
|--------|-----|---------|--------|--------|-------|
| Button | auto×34 | 12×6 | 6 | 8 | text centered; pill/flat variants |
| Entry / Textbox | 220×34 | 8 | 6 | 8 | single line |
| Checkbox | 16×16 | – | 6 | 4 | 12 px gap to label |
| Switch (toggle) | 48×24 | – | 6 | 12 | rounded, knob inset |
| Slider | 200×16 | – | 6 | 8 | |
| Label | auto×20 | – | 6 | 0 | |
| List (boxed) | 320×auto | 12 | 12 | 12 | row height 48; boxed-list card |
| List row | 320×48 | 12 | 0 | 0 | |
| Scrollbar | 14×auto | – | 0 | 7 | overlay thin ~8 |
| Card / section | auto | 12 | 12 | 12 | 18 between groups |
| Window | – | 12 | 0 | 12 | 12 px content margin |
| Clock | 120×40 | 8 | 6 | 8 | |
| Calendar | 300×300 | 6 | 6 | 12 | 7-col grid |

### KDE (Kirigami / Breeze)

| Widget | w×h | padding | margin | radius | notes |
|--------|-----|---------|--------|--------|-------|
| Button | auto×30 | 8×4 | 4 | 4 | Breeze = low radius |
| Entry / Textbox | 220×30 | 6 | 4 | 3 | |
| Checkbox | 18×18 | – | 4 | 3 | 6 px gap to label |
| Switch (toggle) | 44×22 | – | 4 | 11 | |
| Slider | 200×18 | – | 4 | 4 | |
| Label | auto×18 | – | 4 | 0 | gridUnit tall |
| List | 320×auto | 8 | 8 | 3 | row height 36 |
| List row | 320×36 | 8 | 0 | 0 | largeSpacing padding |
| Scrollbar | 12×auto | – | 0 | 6 | |
| Card / section | auto | 8 | 8 | 4 | |
| Window | – | 8 | 0 | 4 | |
| Clock | 110×36 | 6 | 4 | 4 | |
| Calendar | 300×300 | 6 | 4 | 4 | |

## How the app uses this

- Each **library** (`gtk4`, `kde`) is a lookup: `widgetType → {w, h, padding,
  margin, radius, spacing, …}` plus a display name that matches the toolkit
  (e.g. GTK `GtkButton`, KDE `QPushButton`) for code export.
- Inserting a widget from the Library panel seeds it with that toolkit's defaults.
- An **"apply defaults"** action re-applies the current toolkit's metrics to the
  selected element (paddings/margins/radius), so a hand-drawn box snaps to spec.
- Switching toolkit re-maps the exported component names/props.

## Control rules

- Preserve button padding in fixed and hug modes. If text does not fit, shorten
  the imperative label or widen the button; never collapse its padding.
- Keep neighboring action buttons equal in height and preferably equal in width.
- Use a nearby title/subtitle for context, for example `3 enrolled faces` plus
  an `Edit Faces` button instead of a long sentence inside the button.
- Render switch handles with a theme-derived neutral foreground/handle color.
  Black is not a universal GTK or KDE switch-knob token. Keep the track accent
  distinct from the handle and retain high-contrast compatibility.
- Use switches for immediately applied settings and checkboxes for settings that
  are committed later with Apply/OK.

## Sources

- [GNOME Human Interface Guidelines](https://developer.gnome.org/hig/)
- [GNOME HIG — Buttons](https://developer.gnome.org/hig/patterns/controls/buttons.html)
- [Libadwaita styles and high contrast](https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/styles-and-appearance.html)
- [GNOME HIG — Layout (Wiki archive)](https://wiki.gnome.org/Design/HIG/Planning/Layout) — 12 px window margin, 12 px label↔control
- [KDE Human Interface Guidelines](https://develop.kde.org/hig/)
- [KDE HIG — Getting input](https://develop.kde.org/hig/getting_input/)
- [KDE HIG — Layout and navigation](https://develop.kde.org/hig/layout_and_nav/)
- [KDE HIG — Units & Measurements](https://develop.kde.org/hig/layout/units.html)
- [Kirigami Units (smallSpacing 4 / large 8)](https://invent.kde.org/frameworks/kirigami/-/merge_requests/479)
- [Kirigami::Units class reference](https://api.kde.org/kirigami-platform-units.html)
