# PixelRuller AI Design Workflow

Use this guide when an AI works with a UI designed in PixelRuller.

## Purpose

Treat PixelRuller as a shared visual design surface between a human and an AI. It is not a programming language, a low-code platform, or the place where application behavior is implemented.

- The human edits the interface visually.
- PixelRuller stores the design as precise, readable data.
- The AI reads that data and implements the real application in the project's chosen toolkit or framework.

## Core rules

1. Treat the canonical design JSON as the source of truth for the interface.
2. Preserve the human's visual decisions: hierarchy, order, sizes, percentages, spacing, colors, typography, alignment, borders, and widget names.
3. Keep business logic, file pickers, commands, validation, navigation, and other runtime behavior in the real application code.
4. Do not add programming concepts to PixelRuller merely to make one sample application work.
5. Keep the relationship one-to-one: visible design properties must exist in the JSON and must translate to the implementation.
6. Do not invent behavior from appearance alone. Infer ordinary widget intent when it is obvious; otherwise use the user's description or the target application's existing behavior.
7. Prefer nested sections and relative layout over fixed positioning. Use fixed positioning only when the design explicitly requires it.

## Understand the project

Before changing a design or implementing it:

1. Read `README.md` for the user workflow.
2. Read `Map.md` for the project structure and important functions.
3. Read the relevant design JSON under `web/` or the path supplied by the user.
4. Inspect the target application's existing code before choosing implementation details.

## Read a PixelRuller design

The important document fields are:

- `canvas`: design size and background.
- `shapes`: all windows, sections, widgets, icons, rectangles, and ellipses.
- `id`: stable element identity.
- `name`: human-readable identity; use it to map a design element to code.
- `parent` and `slot`: hierarchy and order.
- `widget`: semantic widget type.
- `layout`, `align`, `gap`, `padding`, and `margin`: container layout.
- `sizeModeX` and `sizeModeY`: `fixed`, `fill`, `percent`, or `hug` sizing.
- `widthPercent`, `heightPercent`, `grow`, and min/max values: responsive sizing.
- `fill`, `stroke`, `radius`, `opacity`, `fontSize`, `textColor`, `alignH`, and `alignV`: appearance.
- `text`, icons, and widget state fields: visible content and initial state.

Use `id` and `name` together when comparing revisions. Do not rely only on `x` and `y`, because managed containers recalculate child geometry.

## Human-to-AI workflow

1. Open or load the canonical design in PixelRuller.
2. Let the human make visual changes in the editor.
3. Export the updated JSON.
4. Save the approved export back to the canonical project path without discarding unrelated user changes.
5. Compare the old and new JSON by element identity and hierarchy.
6. Translate only the approved design changes into the real application code.
7. Run appropriate code checks and visually inspect the implementation at normal and resized window dimensions.
8. Report which design file was used, which code was changed, and any difference that could not be reproduced exactly.

## AI-to-human workflow

When the AI creates or improves a design:

1. Build the interface from named semantic widgets, not decorative rectangles when a real widget exists.
2. Compose complex areas from sections inside sections.
3. Use vertical, horizontal, table, percentage, fill, grow, and hug sizing to express responsive intent.
4. Keep each widget's role clear from its `name` and visible text.
5. Save the result as a canonical JSON file that the human can reopen and edit.
6. Reload it in PixelRuller and inspect it visually before handing it back.

## Boundaries

PixelRuller may describe that a control is a button, textbox, menu, progress bar, or file field. The target application decides what happens when the user interacts with it.

For example, a PDF application's `Browse…` button belongs in the PixelRuller design, but the native file-picker implementation belongs in the PDF application's code. Do not add a general action engine to PixelRuller for this.

## Completion checklist

- The canonical JSON contains the latest approved visual state.
- Widget hierarchy and responsive sizing survive reload.
- The implementation matches the design at more than one window size.
- No application-specific behavior was pushed into PixelRuller.
- The human can continue editing the same design and the AI can continue from the resulting JSON.
