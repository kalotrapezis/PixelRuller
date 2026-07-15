# Map — PixelRuller code map

**PixelRuller** is a zero-dependency pixel-measuring web app for KDE/Wayland. A Python stdlib HTTP server (server.py) captures screenshots via `spectacle` and serves static files, while the web frontend (app.js on HTML5 canvas) provides interactive measuring: grid overlay, AutoCAD-style crosshair, point/area measurement, snapping, selection, editing, and JSON export. All coordinate math and rendering happens client-side; the server only captures and persists.

**Update this file whenever files or functions change.**

---

## server.py

The HTTP server captures the desktop via `spectacle` and manages file I/O. It runs a threaded Python stdlib server on localhost, serves static files from the `web/` directory, and exposes three POST endpoints for capture, saving annotated images, and exporting measurement JSON. Paths use locale-aware directory resolution (xdg-user-dir or fallbacks) to save to the user's Pictures folder.

| Name | One-line summary |
|------|-----------------|
| `pictures_dir()` | Resolve the user's Pictures directory (locale-aware, xdg or fallback). |
| `save_dir()` | Return the PixelRuller subfolder in Pictures, creating it if needed. |
| `capture_screenshot()` | Call `spectacle` with flags and return raw PNG bytes or raise. |
| `unique_path(name, ext)` | Return a non-clobbering filename in PixelRuller folder by appending `_2`, `_3` etc. |
| `Handler.log_message()` | Suppress HTTP server log spam (empty override). |
| `Handler._send(code, body, content_type)` | Send an HTTP response with headers and body. |
| `Handler._read_json()` | Parse the request body as JSON (defaults to `{}`). |
| `Handler.do_GET()` | Serve static files from `web/` directory; 404 if not found or outside directory. |
| `Handler.do_POST()` | Route POST to `/capture`, `/save`, `/save-json` endpoints or 404. |
| `Handler.handle_capture()` | Capture the desktop and return base64-encoded PNG as JSON. |
| `Handler.handle_save()` | Accept a base64 PNG data URL and name; write PNG file to disk. |
| `Handler.handle_save_json()` | Accept JSON payload and name; write JSON file to disk. |
| `Handler.handle_save_text()` | Accept text payload and name; write .txt (flow outline) to disk. |
| `Handler.serve_static(base, rel)` | Serve a file from base dir with a path-traversal guard. |
| `Handler.handle_assets_list()` | GET /assets → JSON list of `{name, src}` SVGs under Assets/SVGs. |
| `main()` | Parse CLI args (--grid, --no-open, --port); start server; optionally open browser. |

---

## web/app.js

The interactive frontend running on an HTML5 canvas. Manages measurement state (image, shapes, grid, snapping), rendering (geometry transform, drawing primitives, labels), and event handling (keyboard, mouse, wheel). Core verbs: capture screenshot, draw points/areas with snapping aids (90°/45°/equal-length), select/edit shapes by name/label/color, undo/clear, save PNG, export JSON. Every interaction is a canvas operation that re-renders the scene.

| Name | One-line summary |
|------|-----------------|
| **State object** | `state` — ready/docMode/background/bgColor, W/H, view transform, mode, drag, snap, grid, snapPoints/eqLen/distInput, shapes[], selected, propOpen, building, mouse, panning. |
| **DOM/Canvas** | `canvas`, `ctx`, `stage`, `coordsEl`, `hintEl`, `dpr` — references and device pixel ratio. |
| `toScreen(tf, x, y)` | Convert image-space coordinates to screen-space using transform. |
| `screenToImage(sx, sy)` | Convert screen-space coordinates to image-space. |
| `dist(a, b)` | Return Euclidean distance between two points. |
| `applySnap(last, cur)` | Apply 90° or 45° angle constraint to `cur` relative to `last`. |
| `allVertices()` | Generator yielding all vertices from committed shapes and in-progress area. |
| `effectivePoint()` | Compute the final cursor position after all snapping aids (vertex snap, angle snap, equal-length). |
| `snapMoveDelta()` | Preview canvas movement against the active grid and nearby element edges/centres; dropping into an active container assigns parent/slot and rejoins its managed layout. |
| `polygonArea(pts)` | Return signed area of a polygon using shoelace formula. |
| `centroid(pts)` | Return center of mass of point array. |
| `resizeCanvas()` | Update canvas CSS and resolution to match stage size; re-render. |
| `fitToView()` | Zoom and pan so the image fills the viewport. |
| `zoomAt(sx, sy, factor)` | Zoom by factor while keeping image point under cursor fixed. |
| `drawScene(g, tf, W, H, opts)` | Clear and render the entire scene: image, grid, shapes, preview, crosshair. |
| `drawGrid(g, tf, W, H)` | Draw ruler grid with major/minor lines and labeled intervals. |
| `drawPoint(g, tf, s, showText)` | Draw a point marker (crosshairs + circle) with coordinate label. |
| `drawArea(g, tf, s, building, showText)` | Draw polygon (fill + stroke), segments with lengths, vertices, area + name at centroid. |
| `drawSelection(g, tf, s)` | Draw dashed bounding-box highlight + handles around selected shape. |
| `buildingPreview(withCursor)` | Return the in-progress area shape, optionally with cursor position appended. |
| `drawCrosshair(g)` | Draw AutoCAD-style crosshair (white lines + circle at cursor). |
| `labelText(g, x, y, text, color, center)` | Draw text with dark rounded-rect backdrop for legibility. |
| `roundRect(g, x, y, w, h, r)` | Draw a rounded rectangle path (used by labelText). |
| `hexToRgba(hex, a)` | Convert `#rrggbb` to `rgba(r,g,b,a)`. |
| `render()` | Refresh snap indicator, draw scene with cursor chrome, update readout. |
| `updateReadout()` | Update coords display (image size or cursor position + delta). |
| `sleep(ms)` | Return a promise resolving after `ms`. |
| `runCountdown(seconds)` | Full-screen countdown timer before capture. |
| `capture()` | POST /capture; load image or toast error. |
| `loadImage(dataUrl)` | Set screenshot background, mark ready, fit view, clear shapes, render. |
| `newCanvas(w, h)` | Create a blank design canvas of given size (canvas mode, no background). |
| `applyModeUI()` | Toggle toolbar tools/labels/cursor + relocate groups + resize for screenshot vs canvas mode. |
| `showStart()` / `hideStart()` | Show/hide the start-mode chooser overlay. |
| `loadDesign(doc)` | Rebuild state (mode, canvas size, shapes, grid) from a design document. |
| `loadDesignFromFile(file)` | Read a JSON File and pass parsed doc to loadDesign. |
| `loadDesignFromUrl(path)` | Load a same-origin canonical JSON design from `?design=...`; used for reproducible examples and responsive UI tests. |
| `drawElement(g, tf, s, showText)` | Draw a rect/ellipse/icon/widget element (dispatches icons & widgets). |
| `drawWidget(g, tf, s, p, w, h, showText)` | Render UI widgets, including editable chrome/navigation controls and SVG icons embedded inside Buttons, Tool buttons, Menu items, and Textboxes. |
| `.pp-copy` / `.pp-val` listeners | ⧉ copies a color hex to the clipboard; clicking a slider's value swaps it for a number input (Enter/blur applies, Esc cancels). |
| `isContainer(s)` / `parentContainer(s)` | Section/Window test; smallest container holding a shape's center. |
| `childrenOf(c)` / `slotOf(s)` | A container's children (by `parent` id; geometry fallback for legacy shapes); a child's slot order. |
| `adoptShape(s)` | Re-parent a dropped/inserted element into the container under its center; insert at the slot matching drop position, renumber siblings. |
| `strokeColor(s, c)` / `side4(v, def)` | Border color with the element's strokeOpacity applied; normalize margin/padding (number or object) to {t,r,b,l}. |
| `copyStyle()` / `pasteStyle()` | Style clipboard: copy the selected element's effective style keys, apply to the selection (🖌 buttons). |
| `THEMES` / `buildPalette()` / `renderSwatches()` / `applyThemeToDesign()` | GTK/KDE light+dark palettes in the bottom bar; swatch click=fill, right-click=border; theme the whole design by widget role. |
| `refreshTree()` | Rebuild the sidebar Elements tree (hierarchy by parent/slot + free elements): click=select, drag=re-parent/reorder (+z lift), ▲=bring to front. Called from relayout/selection changes. |
| `runCommand(str)` / `execCommand(str)` | Command-line entry point (logs to `cmdLog`) / the verb interpreter: add (including empty/deep-copy windows), set (dotted paths), move (dx/dy or into+slot), resize, del, copy, rename, select, arrange, theme, list, help. |
| `findShape(ref)` / `tokenize` / `parseVal` | Resolve an element by id / exact name / name prefix; split a command into quoted-aware tokens; string→number/bool coercion. |
| `#cmdInput` / `#cmdHist` (IIFE) | Bottom-bar command input: Enter runs, ↑/↓ history recall, popup of past commands (click to reuse). |
| `hugDimensions()` / `prepareLayoutSize()` | Compute deterministic natural widget size from toolkit metrics/text and apply per-axis hug + min/max constraints. |
| `arrangeInto(c)` | Layout core: fixed/fill/hug/percentage sizing, grow weights, wrap/spans, overflow extents, scroll offsets, and optional bound Scrollbar→parent control. |
| `containerViewport()` / `clipOverflowAncestors()` / `pointInsideOverflowAncestors()` | Compute content viewports; clip nested descendants while drawing and exclude clipped areas from hit-testing. |
| `arrangeChildren(c)` | Manual Arrange button wrapper around arrangeInto (with toasts; for layout-"none" containers). |
| `layoutWindows()` | Auto-stack all Window widgets vertically (margin/gap 60, one column) with their children, and auto-size the document extent (state.W/H) to the window table. |
| `relayout()` | Automatic layout pass (canvas mode): stack windows, then arrangeInto every container whose layout isn't "none" (undefined layout ⇒ auto vertical). Runs on drag-end/insert/paste/delete/property-edit/load. |
| `WIDGETS` | Widget registry: per-toolkit defaults, including composable chrome/navigation widgets (Title/Status/Path bars, Tabs, Search, Split pane, Spacer, Window controls) and Menubar/Toolbar children. |
| `insertWidget(kind, toolkit, at)` | Insert a toolkit widget at the view center or an explicit Library drop point; adopt it into the smallest container. |
| `addPresetChild()` / `composeWindowPreset()` / `insertWindowPreset()` | Build editable toolkit trees from the supplied references. GTK follows `presets/GTK-Start.xml`. KDE follows `presets/KDE-Window.xml`, including full-width chrome and Toolbar → navigation buttons / growing spacer / Search / Hamburger. |
| `cloneWindowVariant(source, options)` | Deep-copy a Window and every descendant with remapped ids/parents, preserve semantic child names, attach variant metadata, resize, and reflow relative layouts. |
| Library native drag/drop | Widget cards carry `application/x-pixelruller-widget`; canvas drop inserts at image coordinates and adopts into Window/Section/Menubar/Toolbar. |
| Tabs canvas click | In Select/Move mode, clicking a tab computes its index and updates `active`; Select does not create a movement drag. |
| `seedSessionWindow()` | Seed a new blank design with a composed toolkit "Session" window preset. |
| `zOf/topZ/bottomZ/nextZ/zOrder` | Depth (z-order) helpers; zOrder gives back-to-front (or reversed) indices. |
| `bringFront()` / `sendBack()` | Change the selected element's depth. |
| `copySelected/cutSelected/pasteClipboard/duplicateSelected` | Element clipboard operations. |
| `buildFlowText()` / `saveFlowText()` | Build & save the plain-text flow outline (windows + contained widgets). |
| `buildXml()` / `elementXml()` / `saveXml()` | Build & save the design as a nested XML tree (canvas>window>widget). |
| `htmlChildSizing()` / `htmlNodeStyle()` / `htmlContainerStyle()` | Translate the canonical layout tree into CSS sizing, appearance, and nested container rules; percentage rows remain proportional and only explicit Fixed children become absolute. |
| `htmlElement()` / `htmlLeaf()` | Translate containers and toolkit widgets into nested semantic HTML/native controls. |
| `embeddedAssets()` / `buildHtmlCode()` / `saveHtmlCode()` | Embed referenced assets and export a self-contained runnable `.html` file from the current design. |
| `centerIn(s, w)` | True if shape s's center lies within window w's bounds. |
| `isWindow(s)` | True for the window widget (root parent, undeletable when sole). |
| `getIconImage(src)` | Load & cache an SVG asset image from /assets/<src>; shared by standalone icons and icon-bearing widgets; re-renders on load. |
| `refreshWidgetIconOptions()` | Populate the Properties icon selector from the same `/assets` list used by the Library. |
| `insertIcon(src, name)` | Place an icon element (from the Library) centered in the view. |
| `loadLibrary()` | Fetch /assets and build the Library icon grid. |
| `uniqueName(base)` | A shape name unique among current shapes. |
| `shapeBBox(s)` | Axis-aligned bounding box of any shape in image coords. |
| `handlePoints(bb)` / `handleAtScreen(s,sx,sy)` | Resize-handle positions; which handle is under the cursor. |
| `styleFromToolbar()` | Read fill/stroke/strokeWidth/radius from the toolbar inputs. |
| `nextName(type)` | Auto-name a new element ("Rectangle 1", "Ellipse 2"…). |
| `draftElement()` / `commitDraft()` | The element being dragged out; commit it on mouseup. |
| `translateShape(s, dx, dy)` | Move any shape (element x/y, point, or area vertices). |
| `resizeElement(s, handle, ix, iy)` | Resize an element by dragging one of its 8 handles. |
| `isElement(s)` | True for rect/ellipse design elements. |
| `openProps(i)` / `closeProps()` | Populate/clear the docked sidebar properties panel (empty-state class). |
| `syncPropsToSelection()` | Panel follows the primary selection in canvas mode (called by select helpers/marquee). |
| `relocateGroups(toCanvas)` | Move mode+action groups → sidebar `#toolsHost`, grid/show → bottom bar (and back). |
| `syncPropPanel()` / `applyPropPanel()` | Push element→fields / fields→element for the properties panel. |
| `PP(id)` | Shorthand for the properties panel's `pp<Id>` input elements. |
| `commitPoint()` | Add a point shape at effective cursor position. |
| `addAreaVertex()` | Add vertex to building area; detect first-point click to close polygon. |
| `finishArea(closed)` | Finalize building area, add to shapes; optionally auto-save. |
| `updateDistBox()` | Show/hide and position AutoCAD-style typed-distance input box. |
| `commitTypedDistance()` | Place vertex at parsed distance along aim direction. |
| `equalizeSelected()` | Rebuild selected area: all segments → average length; straighten near-axis; compass-rule closure. |
| `undo()` | Pop last vertex from building or last shape from shapes; clear selection. |
| `clearAll()` | Reset shapes, building, selection. |
| `distToSegment(p, a, b)` | Return distance from point `p` to line segment `a–b`. |
| `pointInPolygon(p, pts)` | Return true if `p` is inside polygon using ray-casting. |
| `hitTest(p)` | Return index of topmost shape (point/area/rect/ellipse) under point `p` or null. |
| `selectOnly/clearSelection/toggleInSelection` | Maintain `selection` (all) + `selected` (primary). |
| `finalizeMarquee(m)` | Select elements intersecting the marquee (excludes fully-containing backgrounds). |
| `groupSelection()` / `ungroupSelection()` | Wrap selection in a Section / remove a selected Section. |
| `selectAt(sx, sy)` | Hit-test at screen coords; set selected and sync toolbar inputs. |
| `syncInputsFromSelection()` | Load selected shape's name/label/color into toolbar. |
| `applyInputsToSelection()` | Push toolbar name/label/color onto selected shape. |
| `deleteSelected()` | Remove selected shape from list. |
| `save()` | Render image at true resolution without chrome; POST to /save. |
| `serializeShape(s)` | Convert a shape to JSON with computed metrics (segments, perimeter, area). |
| `exportableShapes()` | Return committed shapes + in-progress area (if any) as array. |
| `buildExport()` | Build the canonical design document (canvas, grid, shapes+metrics) — source of truth. |
| `boundingBox(pts)` | Return `{x, y, width, height}` of points' axis-aligned bounding box. |
| `exportJson()` | POST buildExport() to /save-json. |
| `toast(msg, isError)` | Show bottom-center notification (auto-hide after 3.2s). |
| `setActive(selector, el)` | Toggle CSS class `active` on a group of buttons. |
| **Event listeners** | Separate Select / Move / Camera safety model: Select changes selection and resizes only, Move alone creates move/adopt/reorder drags, Camera/Space/middle-drag pans before hit-testing; plus drawing, property, file and keyboard handlers. |

---

## web/index.html

Single-page HTML structure: a toolbar with grouped controls (capture timer, mode buttons, snap options, grid, show-numbers, area properties, action buttons), a stage canvas for rendering, overlays for hints/countdown/typed-distance/toasts, and a script tag loading app.js.

| Element/Region | Role |
|---|---|
| `#toolbar` | Flex container holding all control groups; wraps at narrow widths. |
| Capture group | Capture button + timer dropdown. |
| Mode group | Point/Area screenshot tools plus Rect/Ellipse/Select/Move/Camera canvas tools. |
| Snap group | Off/90°/45° radiobuttons + points/equal-length checkboxes. |
| Grid group | Toggle button + spacing input. |
| Show group | Numbers checkbox. |
| Area group | Name/label text inputs + color picker. |
| Action group | Finish/Equalize/Undo/Clear buttons. |
| Save group | Save button + JSON export + auto-save checkbox. |
| Coords display | Right-aligned monospace readout (image size or cursor coords). |
| `#stage` | Fullscreen container below toolbar (absolute positioned). |
| `#canvas` | Drawing surface (absolute positioned, absolute top/left). |
| `#hint` | Centered help text overlay. |
| `#countdown` | Full-screen countdown timer (hidden by default). |
| `#distBox` | Cursor-following AutoCAD-style distance input (hidden by default). |
| `#sidebar` | Creation-mode docked **left sidebar**: collapsible, hosts the Tools category (`#toolsHost` — relocated mode + action groups) and `#propPanel`. |
| `#propPanel` | Docked element properties (inside `#sidebar`): collapsible sections with sliders/checkbox/alignment; follows the selection, shows an empty state when nothing is selected. |
| `#bottomBar` | Creation-mode bottom bar hosting relocated grid/show-numbers groups. |
| `#library` | Creation-mode right Library panel: searchable widget list and icon grid from Assets/SVGs; Sections and Navigation open by default, secondary groups collapse. |
| `#scaleBox` | Bottom-left zoom/scale % readout. |
| `#addWin` / `#windowDialog` | Floating ＋ opens the chooser for a new empty toolkit Window or a complete responsive/state copy of an existing Window; all roots remain visible in the table. |
| `#start` | Start-mode chooser overlay (Screenshot / New canvas / Load). |
| `#toast` | Bottom-center notification (hidden by default). |

---

## web/style.css

Dark theme with blue accents. Defines CSS variables (--bg, --panel, --border, --text, --accent), toolbar layout (flex row wrapping), button/input/select styling, canvas stage (checkered background), overlays (hint, countdown, distance box, toast), and animations (toast slide-up).

| Style block | Purpose |
|---|---|
| `:root` variables | --bg, --panel, --panel-hi, --border, --text, --muted, --accent, --accent-hi. |
| `html, body` | Zero margin, full height, dark background, system-ui font, overflow hidden. |
| `#toolbar` | Flex row, wrap, gap, padding, background, border-bottom. |
| `.group` | Flex row, center alignment, gap; `.group.grow` flex-right. |
| `.label`, `.unit` | Uppercase muted text. |
| `button`, `button.hover/active/active` | Dark background, border, rounded, padding; active/primary = blue; hover = lighter. |
| `input[text/number]`, `select` | Dark background, border, rounded, monospace-ready. |
| `input[color]` | Fixed size, padding, rounded. |
| `.checkbox` | Flex row, small text, cursor pointer. |
| `.coords` | Monospace, blue accent, dark background, border, min-width, right-aligned. |
| `#stage` | Absolute inset, overflow hidden, checkered background pattern. |
| `#canvas` | Absolute top-left, cursor none. |
| `.hint` | Centered overlay, muted text, pointer-events none. |
| `.countdown` | Full inset, flex center, large bold white text, semi-transparent dark backdrop. |
| `.countdown.show` | Display flex. |
| `.distbox` | Absolute, dark border + blue text, monospace, pointer-events none. |
| `.distbox.show` | Display block. |
| `.toast` | Absolute bottom-center, dark background, border, padding, opacity 0, transition, pointer-events none. |
| `.toast.show` | Opacity 1, slide-up transform. |
| `.toast.error` | Red border. |

---

## run.sh

Bash launcher script. Changes to the script directory and delegates all arguments to `server.py`.

| Line | Purpose |
|---|---|
| Shebang + comment | Identify as Bash script and document usage. |
| `cd "$(dirname "$0")"` | Change to script directory (PixelRuller root). |
| `exec python3 server.py "$@"` | Run server.py with all passed arguments (--grid, --no-open, --port). |

---

## Other files

| File | Summary |
|---|---|
| `README.md` | User guide: run instructions, screenshot & canvas modes, properties panel, keyboard shortcuts, file descriptions. |
| `plan.md` | Living roadmap moving PixelRuller from measuring tool to shared UI design canvas: element model, modes, create-mode UI, operation schema, command line, code binding. |
| `libraries.md` | Researched GTK 4 & KDE spacing systems + per-widget default metrics for one-click library defaults (with sources). |
| `Assets/README.md` | Assets folder layout; `Assets/SVGs/` (~117 icons) → planned `icon`/`svg` UI elements. |
| `presets/GTK-Start.xml` | Canonical minimal GNOME/GTK default window supplied by Teo; reference tree for `composeWindowPreset`. |
| `presets/KDE-Window.xml` | Canonical KDE visual reference supplied by Teo; reference tree for the KDE branch of `composeWindowPreset`. |
| `web/PDFExtractorUI.json` / `web/PDFExtractorUI-code.html` | Responsive PDFExtractor design fixture and its generated runnable-code reference used for one-to-one visual/layout verification. |
| `.claude/launch.json` | Dev server config: `pixelruller` runs `python3 server.py --no-open --port 8779`. |

---

**Total documented:** ~50 functions/constants/listener groups in app.js; 13 functions in server.py; 16 HTML regions; ~20 CSS blocks; run.sh launcher.
- Composite widget model: `makeWidgetSelection()`, `enterComposite()`,
  `exitComposite()`, `cornerRadii()`, `compositePath()`, and
  `drawCompositeBorder()` implement wrapper-first selection, child-edit mode,
  separate outer-frame styling, rounded subtree clipping, hierarchy-aware
  movement/copy/paste/ungroup, and JSON/XML persistence.
- Drop affordances: `dropHintAt()` computes the smallest cycle-safe target and
  insertion slot for both Library and Elements-tree drags; `drawDropHint()`
  renders the container highlight and exact insertion line.
- Widget text alignment: `alignedText()` inside `drawWidget()` is the shared
  bounded H/V renderer for single-label widgets; `defaultTextAlign()` keeps the
  Properties fallback in sync with the actual renderer.
