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

Use the approved blue-gray layered treatment:

- A dark translucent overlay separates the dialog from the underlying file-management content.
- The dialog surface is slightly lighter and bluer than the panel background.
- A thin blue border and restrained shadow make the card boundary clear.
- Dialogs share the same radius, spacing, maximum viewport-relative width, and focus treatment.
- Dialog width may vary with content, but placement and surface styling do not.
- Existing semantic action button colors remain unchanged.

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
