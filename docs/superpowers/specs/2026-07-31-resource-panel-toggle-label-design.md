# Resource Panel Toggle Label Design

## Goal

Simplify the project-resource panel header below the YAML editor by removing the visible `项目资源` label and making the adjacent expand/collapse chevron easier to see.

## Scope

- Update `src/components/ResourcePanel.svelte` only for the visible toggle content and its local styles.
- Update `src/components/ResourcePanel.component.test.ts` to reflect that the visible label is absent while the toggle remains accessible.
- Do not change panel state, tab behavior, resizing, layout outside the toggle, or any other component.

## Design

The toggle remains a native button with its existing state-dependent accessible name: `折叠资源面板` while open and `展开资源面板` while closed. The visible `项目资源` span is removed. The chevron continues to show `⌄` or `›` according to panel state, and its font size changes from `10px` to `14px`. The button's existing padding and click target remain unchanged.

## Verification

The component test will verify that:

- no visible `项目资源` text is rendered;
- the accessible toggle button is still present;
- existing resource tabs and panel behavior remain intact.

Run the targeted `ResourcePanel.component.test.ts` test file after implementation.
