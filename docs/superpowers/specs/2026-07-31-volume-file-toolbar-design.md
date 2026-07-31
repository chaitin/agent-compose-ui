# Volume File Toolbar Design

## Goal

Make volume file actions compact and consistent with the existing script-management
interface. The volume browser header remains one row and file creation never changes
the browser's layout dimensions.

## Toolbar Layout

The toolbar keeps the physical volume label on the left. Its right edge contains two
icon-only actions in this order:

1. Create folder, represented by a folder-plus icon.
2. Upload file, represented by an upload icon.

The current reload action is removed. The inline folder form and visible file input are
also removed, so the toolbar does not wrap into a second row. Both icon buttons retain
accessible names and hover tooltips. Busy, dirty-draft, unavailable-service, and
missing-volume states continue disabling actions under the existing rules.

## Create Folder Dialog

Activating the create-folder icon opens a centered modal dialog styled like the
existing new JavaScript script dialog. It does not occupy toolbar or file-pane layout
space.

The dialog contains:

- a command-style header titled `新建文件夹`;
- one folder-name input that receives focus when the dialog opens;
- a cancel button and a primary create button;
- Enter-to-submit behavior through a form;
- Escape and cancel-button dismissal when no mutation is in progress.

Submitting a blank or whitespace-only name is disabled. While creation is running, the
input and dismissal controls are disabled to avoid losing operation state. Success
closes the dialog, clears its input, and refreshes the current directory. Failure keeps
the dialog and entered name available for correction or retry while displaying the
existing safe error message in the browser.

## Upload Interaction

The upload icon activates a visually hidden native single-file input. Selecting a file
uses the existing upload flow and automatically refreshes the current directory after
success. The input is reset after each attempt so selecting the same file again retries
correctly. Canceling the operating-system picker causes no mutation and no error.

## Component Boundaries

Create a focused `VolumeFolderCreateModal.svelte` component for dialog rendering and
keyboard/form behavior. `VolumeFileBrowser.svelte` remains responsible for API calls,
mutation serialization, current path, and opening or closing the dialog. The modal
receives value, busy state, and submit/close callbacks rather than importing the volume
API.

Icons remain inline SVG assets local to the toolbar because the repository has no
shared icon-component system. Their paths follow the visual weight of existing icon
buttons.

## Error and Recovery Behavior

The previous explicit reload button is removed as requested. Normal create, upload,
save, and delete mutations still refresh automatically. The browser's existing
unavailable and missing-volume messages remain visible; recovery after deployment or
volume creation occurs when the browser component is remounted or the page is
refreshed.

## Testing

Component tests will verify:

- the toolbar is one row with two icon-only accessible actions and no reload button;
- create-folder opens the script-style modal without inserting an inline toolbar input;
- blank submission is disabled, Enter submits, cancel closes, and success closes then
  refreshes;
- failed creation preserves both the dialog and folder name;
- the upload icon opens the hidden file input and preserves same-file retry behavior;
- unavailable, missing, busy, and dirty states still disable the appropriate actions.

Static Svelte checks and the focused volume browser test suite must pass.

## Non-goals

- No changes to the agent-compose daemon or volume-file HTTP API.
- No drag-and-drop upload, multi-file upload, or upload progress redesign.
- No changes to file-list, preview, delete-confirmation, or mount configuration layout.
