# Resource Panel Modal Design

## Scope

Unify the five creation and upload dialogs shown below the YAML editor:

- Create JavaScript file
- Create Skill
- Upload Skill
- Create data volume
- Mount resource

This is a frontend-only presentation change. Existing actions, validation, API calls, concurrency controls, and backend behavior remain unchanged.

## Placement

The resource panel tab bar remains visible and undimmed. A dialog overlay covers only the active `.panel-body` below that tab bar. The dialog card is centered horizontally and vertically within this content area, regardless of the active resource tab or current panel height.

The panel body becomes the positioning boundary. All five dialogs use the same resource-panel overlay contract instead of viewport-level fixed positioning, native default placement, or component-specific positioning.

## Visual Treatment

Use the approved IDE Workbench treatment:

- A dark translucent overlay separates the dialog from the underlying file-management content.
- The dialog uses a matte graphite surface (`#151b23`) and a darker title bar (`#11171e`).
- A neutral gray hairline border (`#303944`) and restrained shadow define the card without a bright blue outline.
- The title bar includes a short monospace command context such as `SCRIPT / CREATE`, `SKILL / UPLOAD`, or `VOLUME / MOUNT`.
- Inputs use a darker inset surface (`#0c1117`) and a neutral border (`#35404d`). Blue appears only for keyboard focus, path values, and the primary action.
- Do not add a colored rail on any card edge.
- Dialogs share the same radius, spacing, maximum viewport-relative width, and focus treatment.
- Dialog width may vary with content, but placement and surface styling do not.
- Existing semantic action button colors remain unchanged.
- Opening uses one restrained fade-and-rise transition of about 100ms and disables it under reduced motion.

## Compact Command Layout

The dialogs use an IDE command-palette density rather than a vertically stacked web form:

- Related labels and controls share a row in a responsive two-to-four-column grid.
- A label and its control remain together when the grid wraps.
- Titles and short context selectors may share the header row.
- Path previews, detected Skill names, and errors use one compact status row only when present.
- Actions align to the right on the final row and may share it with status text.
- A thin blue context strip at the top identifies these dialogs as resource-management commands.
- The card has no internal maximum-height scrolling. Its complete content is visible at once at the normal resource-panel size.

Dialog-specific grouping:

- JavaScript creation: file name and parent directory share a row; path preview and actions share the footer.
- Skill creation: Skill name and target Agent share a row.
- Skill upload: file picker and target Agent share a row; detected name and actions share the footer.
- Volume creation: logical name, target Agent, and mount target share a row where width permits.
- Resource mounting: resource type sits in the command header; resource, Agent, target path, and access mode form one compact grid.
- Cache presets use compact horizontal groups instead of a tall vertical stack.

## Component Boundary

Provide one shared frontend modal shell or equivalent shared resource-panel modal classes. Script, Skill, and mount components opt into this contract. The overlay must be rendered within the active panel content and must not escape to the browser viewport.

The implementation must preserve keyboard behavior, accessible dialog names, disabled states, cancellation behavior, and existing focus management.

## Testing

Add focused regression coverage proving that:

- The resource panel body is the positioning boundary.
- Create JavaScript, create Skill, upload Skill, create volume, and mount resource dialogs use the shared resource-panel overlay and card contract.
- The tab bar is outside the overlay.
- Existing Skills and mounts component suites still pass.
- `svelte-check`, the production build, and formatting checks pass.

## Non-goals

- No backend changes.
- No API or data model changes.
- No redesign of dialog fields or workflows.
- No changes to dialogs outside the YAML resource-management area.
