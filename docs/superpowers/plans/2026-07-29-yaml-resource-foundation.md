# YAML Resource Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lossless, focused YAML mutations that preserve every unrelated project and Agent field.

**Architecture:** Resource forms operate on parsed authoring YAML maps, never reconstructed protobuf objects. Each mutation clones input, changes one owned path, dumps YAML, reparses through `yamlToSpec`, and returns the resulting text or a precise error.

**Tech Stack:** TypeScript, js-yaml, Vitest/Bun test.

---

**Hard boundary:** Every changed file must be inside `agent-compose-ui`. The sibling `agent-compose` repository is an immutable external dependency.

### Task 1: Lossless Agent resource mutations

**Files:**
- Create: `src/lib/project-resources/yaml-mutations.ts`
- Create: `src/lib/project-resources/yaml-mutations.test.ts`
- Modify: `src/lib/yaml.ts`

- [ ] **Step 1: Write failing preservation tests**

Add tests covering an Agent with `scheduler`, `mcp_servers`, `skills`, `volumes`, unknown extension fields, comments-insensitive semantics, and another untouched Agent. Assert `upsertAgentSkill`, `removeAgentSkill`, `upsertAgentMount`, and `removeAgentMount` alter only their owned lists.

```ts
const output = upsertAgentSkill(input, 'developer', {
  name: 'review', provider: 'file', path: './skills/review',
});
expect(parseYamlObject(output).agents.developer.scheduler).toEqual({ enabled: true });
expect(parseYamlObject(output).agents.reviewer).toEqual(parseYamlObject(input).agents.reviewer);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run src/lib/project-resources/yaml-mutations.test.ts`

Expected: FAIL because `yaml-mutations.ts` does not exist.

- [ ] **Step 3: Implement focused immutable mutations**

Export these exact APIs:

```ts
export type SkillYaml = { name: string; provider: string; path?: string; url?: string; ref?: string };
export type MountYaml = { type: 'volume' | 'bind'; source: string; target: string; read_only: boolean };
export function upsertAgentSkill(yaml: string, agent: string, skill: SkillYaml): string;
export function removeAgentSkill(yaml: string, agent: string, skillName: string): string;
export function upsertAgentMount(yaml: string, agent: string, mount: MountYaml): string;
export function removeAgentMount(yaml: string, agent: string, source: string, target: string): string;
```

Use `parseYamlObject`/`dumpYamlObject`, require `agents[agent]` to be a map, replace entries by stable identity, and call `yamlToSpec` before returning.

- [ ] **Step 4: Run tests and type checks**

Run: `npx vitest run src/lib/project-resources/yaml-mutations.test.ts && npm run check`

Expected: PASS and zero Svelte/type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/yaml.ts src/lib/project-resources/yaml-mutations.ts src/lib/project-resources/yaml-mutations.test.ts
git commit -m "feat(resources): add lossless YAML mutations"
```

### Task 2: Volume declarations and project identity

**Files:**
- Create: `src/lib/project-resources/volume-names.ts`
- Create: `src/lib/project-resources/volume-names.test.ts`
- Modify: `src/lib/project-resources/yaml-mutations.ts`
- Modify: `src/lib/project-resources/yaml-mutations.test.ts`

- [ ] **Step 1: Write failing tests for deterministic names and declarations**

```ts
expect(await managedVolumeName('ws_0123456789abcdef0123456789abcdef', 'project-memory'))
  .toMatch(/^ac-[a-f0-9]{12}-project-memory$/);
expect(await managedVolumeName(key, 'project-memory')).toBe(await managedVolumeName(key, 'project-memory'));
```

Assert declaration upsert preserves `variables`, `workspaces`, and existing Volume options.

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run src/lib/project-resources/volume-names.test.ts src/lib/project-resources/yaml-mutations.test.ts`

Expected: FAIL for missing exports.

- [ ] **Step 3: Implement deterministic SHA-256-based naming and declaration APIs**

```ts
export async function managedVolumeName(projectKey: string, logicalName: string): Promise<string>;
export function upsertProjectVolume(yaml: string, key: string, value: {
  name: string; driver: 'local'; labels: Record<string, string>;
}): string;
export function removeProjectVolume(yaml: string, key: string): string;
```

Labels must include `agent-compose-ui.managed=true` and `agent-compose-ui.project-key=<key>`.

- [ ] **Step 4: Run focused and full YAML tests**

Run: `npx vitest run src/lib/project-resources src/lib/yaml-workflow-matrix.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-resources
git commit -m "feat(resources): add managed volume declarations"
```

### Task 3: Resource panel tab state without Workspace changes

**Files:**
- Modify: `src/lib/scripts/workspace.svelte.ts`
- Modify: `src/components/ResourcePanel.svelte`
- Create: `src/components/ResourcePanel.component.test.ts`

- [ ] **Step 1: Write a failing component test**

Render `ResourcePanel`, assert tabs `脚本文件`, `Workspace 文件`, `Skills`, `数据与挂载` exist, and selecting existing Workspace still renders `WorkspacePanel` unchanged.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run src/components/ResourcePanel.component.test.ts`

Expected: FAIL because the new tabs are absent.

- [ ] **Step 3: Extend the active-tab union and panel routing**

```ts
export type ResourceTab = 'scripts' | 'workspace' | 'skills' | 'mounts';
```

Add placeholder panel slots with accessible loading text; do not modify anything under `src/components/workspace/`.

- [ ] **Step 4: Run component regression tests**

Run: `npx vitest run src/components/ResourcePanel.component.test.ts src/components/scripts/ScriptPanel.component.test.ts src/components/workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scripts/workspace.svelte.ts src/components/ResourcePanel.svelte src/components/ResourcePanel.component.test.ts
git commit -m "feat(resources): add project resource tabs"
```
