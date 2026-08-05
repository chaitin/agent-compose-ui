# Collapsible Sidebar Design

## Goal

Make the global left sidebar collapsible without removing access to the product identity or global navigation. Also remove the YAML editor status footer requested in the same UI cleanup.

## Expanded State

The sidebar keeps its current 220px layout. The brand row uses a compact `AC` lettermark followed by “Agent Compose” and a collapse control aligned to the right. The “智能体应用” section heading gains a small orchestration-node icon. Project filtering, project rows, pagination, creation, system management, and feedback remain unchanged.

## Collapsed State

The sidebar becomes a 44px icon rail. It displays only:

- the `AC` lettermark, which expands the sidebar;
- the orchestration-node icon for “智能体应用”, which expands the sidebar;
- the existing system-management icon, which navigates directly;
- the existing feedback icon, which keeps its external-link behavior.

Project rows, filter controls, section text, action buttons, dividers, badges, and all other labels are hidden. Every visible icon has an accessible name and tooltip. Active global navigation remains visually distinct.

## Visual Direction

The controls use the existing workbench palette and typography. The `AC` mark is a restrained square lettermark in the monospace face, with the `C` carrying the existing green accent. The sidebar uses a 160ms width transition and content fades without adding rounded floating controls or a new icon library. Motion is disabled under `prefers-reduced-motion`.

## State and Layout

Collapsed state is stored in browser local storage and survives navigation and reload. The sidebar owns the toggle, while shared store state exposes the current value. The application’s flex layout lets the main area consume the released width automatically.

## YAML Footer Cleanup

Remove the complete YAML editor footer, including agent count, scheduler count, YAML badge, derived count state, unused imports, and footer-only CSS.

## Verification

Tests cover the expanded labels, collapsed icon-only structure, toggle accessibility, persisted state, and absence of the YAML footer. Run focused tests, Svelte diagnostics, and the production build.
