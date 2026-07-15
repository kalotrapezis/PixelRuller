# Assets

Reusable assets, organized **by file type** in subfolders:

```
Assets/
  SVGs/    ← SVG icons (crisp at any zoom — the main icon source)
  …/       ← add more folders per file type as needed (PNGs/, JPGs/…)
```

`SVGs/` already holds ~117 icons (light/dark variants, actions, file types, etc.).

## SVG icons as UI elements

In **canvas (create) mode** each `.svg` in `Assets/SVGs/` becomes an insertable
**icon element**: an element that references a file by name, e.g.

```json
{ "type": "icon", "name": "back", "src": "SVGs/back-svgrepo-com (2).svg",
  "x": 40, "y": 40, "w": 24, "h": 24, "fixed": false }
```

The canvas renders the SVG inside the element's box; the Library panel lists what's
in `Assets/SVGs/` so you can click to place one. Because it's just a numeric box
plus a file reference, the position/size stays exact and round-trips through
`design.json` like every other element.

Tips: kebab-case, action-first names read best in the Library and map cleanly to
code. Light-/Dark- prefixed pairs can auto-swap with the design theme later.

Status: the `icon`/`svg` element type is planned (see `plan.md` → Right Library
panel / SVG icon assets). This folder is the live drop location.
