<script lang="ts">
  import { tick } from 'svelte';
  import { SkillApiError, skillApi, type Entry } from '../../lib/skills/api';
  import { listAgentNames, removeSkillReferences, type SkillReference } from '../../lib/skills/references';
  import { upsertAgentSkill } from '../../lib/project-resources/yaml-mutations';
  import SkillEditor from './SkillEditor.svelte';
  import SkillCreateModal from './SkillCreateModal.svelte';
  import SkillList from './SkillList.svelte';
  import SkillToolbar from './SkillToolbar.svelte';
  import SkillUploadModal from './SkillUploadModal.svelte';

  interface Props {
    projectKey: string;
    yaml: string;
    selectedAgent?: string;
    onYamlChange: (yaml: string) => void | Promise<void>;
  }
  let { projectKey, yaml, selectedAgent = '', onYamlChange }: Props = $props();

  let entries = $state<Entry[]>([]);
  let loading = $state(false);
  let listError = $state('');
  let selected = $state('');
  let content = $state('');
  let savedContent = $state('');
  let sha256 = $state('');
  let reading = $state(false);
  let saveBusy = $state(false);
  let createBusy = $state(false);
  let deleteBusy = $state(false);
  let status = $state('');
  let error = $state('');
  let conflict = $state(false);
  let newName = $state('');
  let targetAgent = $state('');
  let loadGeneration = 0;
  let readGeneration = 0;
  let contextGeneration = 0;
  let saveGeneration = 0;
  let createGeneration = 0;
  let observedProjectKey: string | undefined;
  let deleteTrigger = $state<HTMLButtonElement>();
  let cancelDeleteButton = $state<HTMLButtonElement>();
  let deleteDialog = $state<HTMLDivElement>();
  let modal = $state<'create' | 'upload' | ''>('');
  let pendingSelection = $state('');
  const instanceId = $props.id();
  type DeleteState = {
    projectKey: string;
    skillName: string;
    references: SkillReference[];
    yamlRevision: string;
    nextYaml: string;
    callback: (yaml: string) => void | Promise<void>;
    phase: 'confirm' | 'yamlCommitted' | 'deleting';
    fileError?: string;
    notice?: string;
  };
  let deletion = $state<DeleteState | null>(null);

  const agents = $derived(listAgentNames(yaml));
  const dirty = $derived(content !== savedContent);
  const validProjectKey = $derived(/^ws_[0-9a-f]{32}$/.test(projectKey));

  $effect(() => {
    const key = projectKey;
    if (key === observedProjectKey) return;
    observedProjectKey = key;
    contextGeneration += 1;
    saveGeneration += 1;
    readGeneration += 1;
    saveBusy = false;
    reading = false;
    selected = '';
    content = '';
    savedContent = '';
    status = '';
    error = '';
    deletion = null;
    pendingSelection = '';
    modal = '';
    entries = [];
    if (/^ws_[0-9a-f]{32}$/.test(key)) void loadList(key);
    else {
      loadGeneration += 1;
      loading = false;
    }
  });

  $effect(() => {
    const names = agents;
    const preferred = selectedAgent;
    if (preferred && names.includes(preferred)) targetAgent = preferred;
    else if (!names.includes(targetAgent)) targetAgent = names[0] ?? '';
  });

  async function loadList(key = projectKey): Promise<boolean> {
    if (!/^ws_[0-9a-f]{32}$/.test(key)) return false;
    const version = ++loadGeneration;
    loading = true;
    listError = '';
    try {
      const result = await skillApi.list(key);
      if (version !== loadGeneration || key !== projectKey) return false;
      entries = result.filter((entry) => entry.isDir).sort((a, b) => a.name.localeCompare(b.name));
      return true;
    } catch (value) {
      if (version !== loadGeneration || key !== projectKey) return false;
      listError = message(value);
      entries = [];
      return false;
    } finally {
      if (version === loadGeneration) loading = false;
    }
  }

  function message(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  async function openSkill(name: string, key = projectKey): Promise<void> {
    if (key !== projectKey) return;
    const version = ++readGeneration;
    selected = name;
    reading = true;
    error = '';
    status = '';
    conflict = false;
    try {
      const file = await skillApi.read(key, `${name}/SKILL.md`);
      if (version !== readGeneration || key !== projectKey || selected !== name) return;
      if (typeof file.content !== 'string') throw new Error('Skill 文件响应缺少内容');
      content = file.content;
      savedContent = content;
      sha256 = file.sha256;
    } catch (value) {
      if (version === readGeneration && key === projectKey && selected === name) error = message(value);
    } finally {
      if (version === readGeneration) reading = false;
    }
  }

  function selectSkill(name: string): void {
    if (name === selected) return;
    if (selected && dirty) {
      pendingSelection = name;
      return;
    }
    void openSkill(name);
  }

  function confirmSelection(): void {
    const name = pendingSelection;
    pendingSelection = '';
    if (name) void openSkill(name);
  }

  async function save(): Promise<void> {
    if (!validProjectKey || !selected || saveBusy) return;
    const key = projectKey;
    const name = selected;
    const requestContent = content;
    const expectedHash = sha256;
    const context = contextGeneration;
    const operation = ++saveGeneration;
    saveBusy = true;
    error = '';
    status = '';
    conflict = false;
    try {
      const file = await skillApi.write(key, `${name}/SKILL.md`, requestContent, expectedHash);
      if (operation !== saveGeneration || context !== contextGeneration || key !== projectKey || name !== selected) return;
      sha256 = file.sha256;
      savedContent = requestContent;
      status = '已保存';
    } catch (value) {
      if (operation !== saveGeneration || context !== contextGeneration || key !== projectKey || name !== selected) return;
      if (value instanceof SkillApiError && value.status === 409) {
        conflict = true;
        error = '保存冲突：磁盘内容已变化，本地编辑已保留。';
      } else error = `保存失败：${message(value)}`;
    } finally {
      if (operation === saveGeneration) saveBusy = false;
    }
  }

  async function createSkill(): Promise<void> {
    const name = newName.trim();
    if (!validProjectKey || !name || !targetAgent || createBusy) return;
    const key = projectKey;
    const agent = targetAgent;
    const context = contextGeneration;
    const operation = ++createGeneration;
    createBusy = true;
    error = '';
    status = '';
    let created = false;
    try {
      await skillApi.create(key, name);
      created = true;
      if (context !== contextGeneration || key !== projectKey) throw new Error('项目上下文已变化');
      const next = upsertAgentSkill(yaml, agent, { name, source: 'file', path: `./skills/${name}` });
      await onYamlChange(next);
      if (operation !== createGeneration || context !== contextGeneration || key !== projectKey) return;
      status = `已创建 ${name}`;
      newName = '';
      modal = '';
      const listed = await loadList(key);
      if (!listed || operation !== createGeneration || context !== contextGeneration || key !== projectKey) return;
      await openSkill(name, key);
    } catch (value) {
      if (!created) {
        if (operation === createGeneration && context === contextGeneration) { error = `创建失败：${message(value)}`; modal = ''; }
      } else {
        try {
          await skillApi.remove(key, name, true);
          if (operation === createGeneration && context === contextGeneration) { error = `YAML 更新失败，刚创建的目录已回滚：${message(value)}`; modal = ''; }
        } catch (rollbackError) {
          if (operation === createGeneration && context === contextGeneration) { error = `YAML 更新失败，且目录回滚失败（请手动删除 ${name}）：${message(value)}；${message(rollbackError)}`; modal = ''; }
        }
      }
    } finally { if (operation === createGeneration) createBusy = false; }
  }

  async function uploadSkill(name: string, file: File): Promise<void> {
    if (!validProjectKey || !targetAgent || createBusy) return;
    const key = projectKey; const agent = targetAgent; const context = contextGeneration; const operation = ++createGeneration;
    createBusy = true; error = ''; status = ''; let folder = false;
    try {
      await skillApi.mkdir(key, name); folder = true;
      await skillApi.upload(key, `${name}/SKILL.md`, file);
      if (context !== contextGeneration || key !== projectKey) throw new Error('项目上下文已变化');
      await onYamlChange(upsertAgentSkill(yaml, agent, { name, source: 'file', path: `./skills/${name}` }));
      if (operation !== createGeneration || context !== contextGeneration || key !== projectKey) return;
      status = `已上传 ${name}`; modal = '';
      if (await loadList(key)) await openSkill(name, key);
    } catch (value) {
      if (folder) await skillApi.remove(key, name, true).catch(() => undefined);
      if (operation === createGeneration && context === contextGeneration) error = `上传失败，已回滚：${message(value)}`;
    } finally { if (operation === createGeneration) createBusy = false; }
  }

  function requestDelete(): void {
    if (!selected) return;
    if (document.activeElement instanceof HTMLButtonElement) deleteTrigger = document.activeElement;
    try {
      const removal = removeSkillReferences(yaml, selected);
      deletion = {
        projectKey,
        skillName: selected,
        references: removal.references,
        yamlRevision: yaml,
        nextYaml: removal.yaml,
        callback: onYamlChange,
        phase: 'confirm',
      };
      error = '';
      void tick().then(() => cancelDeleteButton?.focus());
    } catch (value) { error = `无法检查引用：${message(value)}`; }
  }

  async function closeDelete(): Promise<void> {
    if (deleteBusy) return;
    deletion = null;
    await tick();
    if (deleteTrigger?.isConnected) deleteTrigger.focus();
  }

  async function removeCapturedFiles(state: DeleteState): Promise<void> {
    state.phase = 'deleting';
    try {
      await skillApi.remove(state.projectKey, state.skillName, true);
      if (deletion !== state) return;
      deletion = null;
      if (state.projectKey === projectKey && selected === state.skillName) {
        selected = '';
        status = `已删除 ${state.skillName}`;
        await loadList(state.projectKey);
      }
      await tick();
      if (deleteTrigger?.isConnected) deleteTrigger.focus();
    } catch (value) {
      if (deletion === state) {
        state.phase = 'yamlCommitted';
        state.fileError = `YAML 引用已移除，但文件删除失败；文件仍可恢复并可重试：${message(value)}`;
      }
    }
  }

  async function deleteSkill(): Promise<void> {
    const state = deletion;
    if (!state || deleteBusy) return;
    deleteBusy = true;
    try {
      if (state.phase === 'confirm') {
        if (state.projectKey !== projectKey) {
          deletion = null;
          return;
        }
        let refreshed;
        try {
          refreshed = removeSkillReferences(yaml, state.skillName);
        } catch (value) {
          error = `无法刷新引用：${message(value)}`;
          return;
        }
        const identity = (references: SkillReference[]) => references
          .map((reference) => `${reference.agentName}\0${reference.skillName}\0${reference.path ?? ''}`)
          .join('\n');
        if (identity(refreshed.references) !== identity(state.references)) {
          state.references = refreshed.references;
          state.nextYaml = refreshed.yaml;
          state.yamlRevision = yaml;
          state.callback = onYamlChange;
          state.notice = 'Skill 引用已变化，请检查更新后的列表并再次确认。';
          error = 'Skill 引用已变化，请检查更新后的列表并再次确认。';
          return;
        }
        state.nextYaml = refreshed.yaml;
        state.yamlRevision = yaml;
        state.callback = onYamlChange;
        try {
          await state.callback(state.nextYaml);
          if (deletion !== state) return;
          state.phase = 'yamlCommitted';
        } catch (value) {
          if (deletion === state) error = `YAML 更新失败，未删除文件：${message(value)}`;
          return;
        }
      }
      await removeCapturedFiles(state);
    } finally { deleteBusy = false; }
  }

  function handleDialogKeydown(event: KeyboardEvent): void {
    if (!deletion || deleteBusy) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void closeDelete();
      return;
    }
    if (event.key !== 'Tab' || !deleteDialog) return;
    const controls = [...deleteDialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
</script>

<div class="skill-shell" inert={deletion || pendingSelection || modal ? true : undefined} aria-hidden={deletion || pendingSelection || modal ? 'true' : undefined}>
  <SkillToolbar
    busy={createBusy || saveBusy || deleteBusy || !validProjectKey}
    onCreate={() => { modal = 'create'; }}
    onUpload={() => { modal = 'upload'; }}
    onRefresh={() => { void loadList(); }}
  />
  <div class="skill-panel" inert={deletion || pendingSelection || modal ? true : undefined} aria-hidden={deletion || pendingSelection || modal ? 'true' : undefined}>
  <aside>
    <SkillList {entries} {selected} {loading} error={listError} busy={createBusy || deleteBusy} onSelect={selectSkill} onRetry={() => { void loadList(); }} />
  </aside>

  <main>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if status}<p role="status">{status}</p>{/if}
    <SkillEditor
      name={selected}
      {content}
      {dirty}
      reading={reading}
      busy={saveBusy || createBusy || deleteBusy}
      {conflict}
      onContent={(value) => { content = value; }}
      onSave={() => { void save(); }}
      onDelete={requestDelete}
      onReload={() => { void openSkill(selected); }}
    />
  </main>
  </div>
</div>

{#if modal === 'create'}
  <SkillCreateModal {agents} busy={createBusy} name={newName} agent={targetAgent} onName={(value) => { newName = value; }} onAgent={(value) => { targetAgent = value; }} onSubmit={() => { void createSkill(); }} onClose={() => { modal = ''; }} />
{:else if modal === 'upload'}
  <SkillUploadModal {agents} busy={createBusy} agent={targetAgent} onAgent={(value) => { targetAgent = value; }} onSubmit={(name, file) => { void uploadSkill(name, file); }} onClose={() => { modal = ''; }} />
{/if}

{#if pendingSelection}
  <div class="dialog-backdrop">
    <div role="dialog" aria-modal="true" aria-labelledby={`${instanceId}-navigate-title`}>
      <h2 id={`${instanceId}-navigate-title`}>放弃未保存更改？</h2>
      <p>切换到 {pendingSelection} 将丢弃当前 Skill 的本地更改。</p>
      <button type="button" onclick={() => { pendingSelection = ''; }}>继续编辑</button>
      <button type="button" onclick={confirmSelection}>放弃并切换</button>
    </div>
  </div>
{/if}

{#if deletion}
  <div class="dialog-backdrop">
    <div bind:this={deleteDialog} role="dialog" aria-modal="true" aria-labelledby={`${instanceId}-delete-title`} aria-describedby={`${instanceId}-delete-description`} tabindex="-1" onkeydown={handleDialogKeydown}>
      <h2 id={`${instanceId}-delete-title`}>确认删除 {deletion.skillName}</h2>
      <div id={`${instanceId}-delete-description`}>
        <p>将先移除以下 Agent 引用，再删除 Skill 文件：</p>
        {#if deletion.references.length}<ul>{#each deletion.references as reference}<li>{reference.agentName}</li>{/each}</ul>{:else}<p>没有 Agent 引用此 Skill。</p>{/if}
        {#if deletion.notice}<p role="alert">{deletion.notice}</p>{/if}
        {#if deletion.fileError}<p role="alert">{deletion.fileError}</p>{/if}
      </div>
      <button bind:this={cancelDeleteButton} type="button" onclick={closeDelete} disabled={deleteBusy}>取消</button>
      <button type="button" onclick={deleteSkill} disabled={deleteBusy}>{deletion.phase === 'yamlCommitted' ? '重试删除文件' : '确认删除'}</button>
    </div>
  </div>
{/if}

<style>
  .skill-shell { display: grid; grid-template-rows: auto 1fr; height: 100%; min-height: 0; }
  .skill-panel { display: grid; grid-template-columns: minmax(220px, 30%) 1fr; min-height: 0; }
  aside { border-right: 1px solid var(--border-color); padding: 10px; overflow: auto; }
  main { padding: 10px; min-width: 0; overflow: auto; }
  .dialog-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: #0008; }
  [role='dialog'] { width: min(440px, 90vw); padding: 18px; background: var(--bg-secondary); border: 1px solid var(--border-color); }
</style>
