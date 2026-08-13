<script lang="ts">
  import { tick } from 'svelte';
  import { parseYamlObject } from '../../lib/yaml';
  import { deriveProjectResources, type AgentMount, type ProjectDataResource } from '../../lib/project-resources/model';
  import { CACHE_PRESETS } from '../../lib/project-resources/cache-presets';
  import { managedVolumeName } from '../../lib/project-resources/volume-names';
  import { removeAgentMount, removeProjectVolume, upsertAgentMount, upsertProjectVolume, type MountYaml } from '../../lib/project-resources/yaml-mutations';
  import { sharedDirectoryApi, type SharedDirectory } from '../../lib/project-resources/shared-directories';
  import VolumeFileBrowser from './VolumeFileBrowser.svelte';
  import { deleteManagedVolume } from '../../lib/project-resources/delete-volume';
  import { volumeService } from '../../lib/rpc';
  import { RemoveVolumeRequest } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { beginManagedVolumeDeletion } from '../../lib/project-resources/physical-deletion-guard';
  import MountResourceList, { type MountSelection } from './MountResourceList.svelte';
  import MountResourceDetail from './MountResourceDetail.svelte';

  interface Props { yaml: string; projectKey: string; selectedAgent?: string; onYamlChange: (yaml: string) => void | Promise<void>; onApply?: () => Promise<void> }
  let { yaml, projectKey, selectedAgent = '', onYamlChange, onApply = async () => { throw new Error('应用回调未配置'); } }: Props = $props();
  const PROJECT_KEY_PATTERN = /^ws_[0-9a-f]{32}$/;
  const RESOURCE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
  const validKey = $derived(PROJECT_KEY_PATTERN.test(projectKey));
  let logicalName = $state(''); let targetAgents = $state<string[]>([]); let createTarget = $state(''); let targetTouched = $state(false);
  let existingKey = $state(''); let existingAgents = $state<string[]>([]); let existingTarget = $state('');
  let sharedId = $state(''); let sharedAgents = $state<string[]>([]); let sharedTarget = $state(''); let sharedReadOnly = $state(true);
  let catalog = $state<SharedDirectory[]>([]); let catalogLoading = $state(false); let catalogError = $state(''); let catalogGeneration = 0;
  let busy = $state(false); let applyBusy = $state(false); let status = $state(''); let error = $state(''); let applyStatus = $state(''); let volumeBrowserRevision = $state(0);
  let observedKey: string | undefined; let contextGeneration = 0;
  let deletion = $state<{ resource: ProjectDataResource; refs: string[]; revision: string } | null>(null); let deleteTrigger = $state<HTMLButtonElement>(); let cancelDelete = $state<HTMLButtonElement>(); let confirmDelete = $state<HTMLButtonElement>();
  type CleanupState = { projectKey: string; volume: string; declaration: string; error: string; inFlight: boolean; attempt: number; sequence: number; observedYaml: string };
  let cleanups = $state<Record<string, CleanupState>>({}); let cleanupAttempt = 0;
  const instanceId = $props.id();
  const locked = $derived(busy || applyBusy);
  let observedSharedId = '';
  let selection = $state<MountSelection | null>(null);
  let operationModal = $state<'create' | 'mount' | ''>('');
  let resourceType = $state<'volume' | 'cache' | 'share'>('volume');
  let observedAgentOptions = '';

  const agents = $derived(agentNames(yaml));
  const resources = $derived.by(() => { try { return deriveProjectResources(yaml); } catch { return []; } });
  const binds = $derived(bindMounts(yaml));
  const selectedShared = $derived(catalog.find((entry) => entry.id === sharedId));
  const currentCleanup = $derived(Object.values(cleanups).find((item) => item.projectKey === projectKey));
  const cacheKeys = $derived(Object.values(CACHE_PRESETS).map((preset) => preset.suffix));
  const selectedResource = $derived.by(() => { const current = selection; return current?.kind === 'volume' ? resources.find((item) => item.key === current.key) : undefined; });
  const selectedBind = $derived.by(() => { const current = selection; return current?.kind === 'share' ? binds.find((item) => item.source === current.source && item.agent === current.agent && item.target === current.target) : undefined; });
  const selectedBrowsableVolume = $derived(selectedResource && validKey && fileBrowsable(selectedResource) ? selectedResource.systemName : '');
  const selectedBrowseKey = $derived.by(() => { const resource = selectedResource; if (!resource) return projectKey; return volumeOwnerKey(resource) || projectKey; });
  const logicalNameValid = $derived(RESOURCE_NAME_PATTERN.test(logicalName.trim()));
  const createTargetValid = $derived(validMountTarget(createTarget));
  const existingTargetValid = $derived(validMountTarget(existingTarget));
  const sharedTargetValid = $derived(validMountTarget(sharedTarget));
  const createReady = $derived(validKey && logicalNameValid && createTargetValid && targetAgents.length > 0 && !locked);
  const mountReady = $derived(validKey && !!existingKey && existingTargetValid && existingAgents.length > 0 && !locked);

  $effect(() => {
    const key = projectKey;
    if (key === observedKey) return;
    observedKey = key; contextGeneration += 1; status = ''; error = ''; catalog = []; sharedId = ''; deletion = null; selection = null;
    catalogGeneration += 1;
    if (/^ws_[0-9a-f]{32}$/.test(key)) void loadCatalog(key);
    else catalogLoading = false;
  });
  $effect(() => {
    const cleanup = currentCleanup; const currentYaml = yaml;
    if (!cleanup || cleanup.observedYaml === currentYaml) return;
    if (cleanupUnsafe(cleanup) && cleanup.inFlight) saveCleanup({ ...cleanup, observedYaml: currentYaml, error: '卷数据删除正在进行；请等待完成后再应用当前 YAML' });
    else if (cleanupUnsafe(cleanup)) { clearCleanup(cleanup.projectKey, cleanup.volume); error = '待清理卷已重新声明或挂载，已取消数据删除'; }
    else saveCleanup({ ...cleanup, observedYaml: currentYaml });
  });
  $effect(() => {
    const names = agents;
    const context = `${selectedAgent}\0${names.join('\0')}`;
    if (context === observedAgentOptions) return;
    observedAgentOptions = context;
    const preferred = selectedAgent && names.includes(selectedAgent) ? selectedAgent : names[0] ?? '';
    targetAgents = selectedAgents(targetAgents, names, preferred);
    existingAgents = selectedAgents(existingAgents, names, preferred);
    sharedAgents = selectedAgents(sharedAgents, names, preferred);
  });
  $effect(() => { if (!targetTouched) createTarget = logicalName.trim() ? `/data/${logicalName.trim().toLowerCase().replace(/ +/g, '-')}` : ''; });
  $effect(() => { const keys = resources.map((resource) => resource.key); if (!keys.includes(existingKey)) existingKey = keys[0] ?? ''; });
  $effect(() => { if (selectedShared && !selectedShared.writable) sharedReadOnly = true; });
  $effect(() => { const id = sharedId; if (id !== observedSharedId) { observedSharedId = id; sharedReadOnly = true; } });
  $effect(() => {
    const current = selection;
    if (current?.kind === 'volume' && resources.some((item) => item.key === current.key)) return;
    if (current?.kind === 'share' && binds.some((item) => item.source === current.source && item.agent === current.agent && item.target === current.target)) return;
    selection = resources[0] ? { kind: 'volume', key: resources[0].key } : binds[0] ? { kind: 'share', source: binds[0].source, agent: binds[0].agent, target: binds[0].target } : null;
  });

  function agentNames(text: string): string[] {
    try { const root = parseYamlObject(text); return root.agents && typeof root.agents === 'object' && !Array.isArray(root.agents) ? Object.keys(root.agents as object) : []; } catch { return []; }
  }
  function bindMounts(text: string): AgentMount[] {
    try {
      const root = parseYamlObject(text); const definitions = root.agents;
      if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) return [];
      return Object.entries(definitions).flatMap(([agent, value]) => {
        const list = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).volumes : undefined;
        if (!Array.isArray(list)) return [];
        return list.flatMap((item): AgentMount[] => item && typeof item === 'object' && !Array.isArray(item)
          && (item as Record<string, unknown>).type === 'bind' && typeof (item as Record<string, unknown>).source === 'string'
          && typeof (item as Record<string, unknown>).target === 'string' ? [{ agent, type: 'volume', source: String((item as Record<string, unknown>).source), target: String((item as Record<string, unknown>).target), readOnly: (item as Record<string, unknown>).read_only === true }] : []);
      });
    } catch { return []; }
  }
  function canonicalAbsolute(path: string): string | null {
    const trimmed = path.trim();
    if (!trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.split('/').some((part) => part === '.' || part === '..')) return null;
    const canonical = trimmed === '/' ? '/' : `/${trimmed.split('/').filter(Boolean).join('/')}`;
    return canonical === trimmed ? canonical : null;
  }
  function validMountTarget(path: string): boolean {
    const canonical = canonicalAbsolute(path);
    if (!canonical || canonical === '/') return false;
    return canonical.slice(1).split('/').every((part) => RESOURCE_NAME_PATTERN.test(part));
  }
  function selectedAgents(current: string[], available: string[], preferred: string): string[] {
    const next = current.filter((name) => available.includes(name));
    return next.length > 0 ? next : preferred ? [preferred] : [];
  }
  function agentSelectionLabel(selected: string[]): string {
    if (selected.length === 0) return '请选择 Agent';
    if (selected.length === 1) return selected[0];
    return `已选择 ${selected.length} 个 Agent`;
  }
  function identityTarget(path: string): string {
    const parts: string[] = [];
    for (const part of path.trim().split('/')) { if (!part || part === '.') continue; if (part === '..') parts.pop(); else parts.push(part); }
    return `/${parts.join('/')}`;
  }
  function duplicateTarget(agent: string, target: string, text = yaml, ignoreSource?: string) {
    const normalized = identityTarget(target);
    return [...deriveProjectResources(text).flatMap((r) => r.mounts), ...bindMounts(text)]
      .some((mount) => mount.agent === agent && identityTarget(mount.target) === normalized && (!ignoreSource || mount.source !== ignoreSource));
  }
  function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
  function cleanupKey(key: string, volume: string) { return `${key}\0${volume}`; }
  function saveCleanup(state: CleanupState) {
    const next = { ...cleanups, [cleanupKey(state.projectKey, state.volume)]: state };
    const excess = Object.values(next).sort((a, b) => a.sequence - b.sequence).slice(0, Math.max(0, Object.keys(next).length - 32));
    for (const item of excess) delete next[cleanupKey(item.projectKey, item.volume)];
    cleanups = next;
  }
  function clearCleanup(key: string, volume: string) { const next = { ...cleanups }; delete next[cleanupKey(key, volume)]; cleanups = next; }
  function cleanupUnsafe(cleanup: CleanupState): boolean {
    try {
      const root = parseYamlObject(yaml); const declarations = root.volumes;
      if (declarations && typeof declarations === 'object' && !Array.isArray(declarations)) {
        if (Object.values(declarations as Record<string, unknown>).some((value) => value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).name === cleanup.volume)) return true;
      }
      const agents = root.agents;
      if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return false;
      return Object.values(agents as Record<string, unknown>).some((agent) => agent && typeof agent === 'object' && !Array.isArray(agent)
        && Array.isArray((agent as Record<string, unknown>).volumes)
        && ((agent as Record<string, unknown>).volumes as unknown[]).some((mount) => mount && typeof mount === 'object' && !Array.isArray(mount)
          && ((mount as Record<string, unknown>).source === cleanup.declaration || (mount as Record<string, unknown>).source === cleanup.volume)));
    } catch { return true; }
  }
  async function removePhysicalVolume(key: string, volume: string): Promise<void> {
    const release = beginManagedVolumeDeletion(key, volume);
    try {
      const response = await volumeService.removeVolume(new RemoveVolumeRequest({ name: volume, force: true }));
      if (!response.removed) throw new Error('daemon 未确认删除卷，数据仍待清理');
    } finally { release(); }
  }
  function volumeOwnerKey(resource: ProjectDataResource): string {
    try {
      const declarations = parseYamlObject(yaml).volumes;
      const declaration = declarations && typeof declarations === 'object' && !Array.isArray(declarations) ? (declarations as Record<string, unknown>)[resource.key] : undefined;
      const labels = declaration && typeof declaration === 'object' && !Array.isArray(declaration) ? (declaration as Record<string, unknown>).labels : undefined;
      const ownerKey = labels && typeof labels === 'object' && !Array.isArray(labels) ? (labels as Record<string, unknown>)['agent-compose-ui.project-key'] : undefined;
      return typeof ownerKey === 'string' && PROJECT_KEY_PATTERN.test(ownerKey) ? ownerKey : '';
    } catch { return ''; }
  }
  function fileBrowsable(resource: ProjectDataResource): boolean {
    try {
      const declarations = parseYamlObject(yaml).volumes;
      if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) return false;
      const declaration = (declarations as Record<string, unknown>)[resource.key];
      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) return false;
      const value = declaration as Record<string, unknown>; const labels = value.labels;
      return value.external !== true && value.driver === 'local' && !!labels && typeof labels === 'object' && !Array.isArray(labels)
        && (labels as Record<string, unknown>)['agent-compose-ui.managed'] === 'true'
        && PROJECT_KEY_PATTERN.test(String((labels as Record<string, unknown>)['agent-compose-ui.project-key'] ?? ''));
    } catch { return false; }
  }
  function assertReusable(text: string, key: string, expectedName: string): void {
    const root = parseYamlObject(text); const volumes = root.volumes;
    if (volumes === undefined) return;
    if (!volumes || typeof volumes !== 'object' || Array.isArray(volumes)) throw new Error('volumes 必须是映射格式');
    const value = (volumes as Record<string, unknown>)[key]; if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`卷声明 ${key} 冲突：不是可复用的托管卷`);
    const item = value as Record<string, unknown>; const labels = item.labels;
    const owned = labels && typeof labels === 'object' && !Array.isArray(labels)
      && (labels as Record<string, unknown>)['agent-compose-ui.managed'] === 'true'
      && (labels as Record<string, unknown>)['agent-compose-ui.project-key'] === projectKey;
    if (!owned || item.driver !== 'local' || item.name !== expectedName) throw new Error(`卷声明 ${key} 冲突：现有声明不属于当前项目或配置不同，未做任何更改`);
  }
  async function commit(build: (current: string) => string, success: string, generation = contextGeneration, key = projectKey) {
    if (!validKey || locked) return false; busy = true; error = ''; status = '';
    try {
      if (generation !== contextGeneration || key !== projectKey) throw new Error('项目上下文已变化');
      const next = build(yaml); await onYamlChange(next);
      if (generation !== contextGeneration || key !== projectKey) return false;
      status = success;
      return true;
    } catch (value) { if (generation === contextGeneration && key === projectKey) error = message(value); return false; }
    finally { busy = false; }
  }
  async function createVolume() {
    const logical = logicalName.trim(); const selected = [...targetAgents]; const target = createTarget.trim(); const generation = contextGeneration; const key = projectKey;
    if (!RESOURCE_NAME_PATTERN.test(logical)) { error = '逻辑名称必须以小写字母开头，且只能包含小写字母、数字、下划线和短横线'; return; }
    if (!validMountTarget(target)) { error = '挂载目标必须是绝对路径，且每一级目录都要以小写字母开头，只能包含小写字母、数字、下划线和短横线'; return; }
    if (selected.length === 0) { error = '请至少选择一个 Agent'; return; }
    if (selected.some((agent) => duplicateTarget(agent, target))) { error = '所选 Agent 中已有 Agent 使用了该挂载目标'; return; }
    if (locked) return; busy = true; error = ''; status = '';
    try {
      const systemName = await managedVolumeName(key, logical);
      if (generation !== contextGeneration || key !== projectKey) return;
      const declaration = logical;
      assertReusable(yaml, declaration, systemName);
      let next = upsertProjectVolume(yaml, declaration, { name: systemName, driver: 'local', labels: { 'agent-compose-ui.logical-name': declaration, 'agent-compose-ui.project-key': key } });
      for (const agent of selected) {
        if (duplicateTarget(agent, target, next)) throw new Error(`Agent ${agent} 的挂载目标已被使用`);
        next = upsertAgentMount(next, agent, { type: 'volume', source: declaration, target, read_only: false });
      }
      // A YAML mutation is only a local editor change.  The daemon volume is
      // created by ApplyProject, so wait for the real apply callback before
      // reporting success.  Previously this function stopped after
      // onYamlChange(), which made the UI claim that a volume existed while
      // the daemon had never created it (and file operations then returned
      // 404).
      await onYamlChange(next);
      await onApply();
      if (generation === contextGeneration && key === projectKey) {
        status = `已创建并应用 ${declaration}`;
        volumeBrowserRevision += 1;
        operationModal = '';
      }
    } catch (value) { if (generation === contextGeneration && key === projectKey) error = `创建数据卷失败：${message(value)}`; }
    finally { busy = false; }
  }
  async function mountExisting() {
    const selected = [...existingAgents]; const target = existingTarget.trim();
    if (!existingKey || selected.length === 0 || !validMountTarget(target)) { error = '请选择卷和至少一个 Agent，并输入符合命名格式的绝对路径'; return; }
    // Re-mounting the same volume to an Agent that already has it is idempotent
    // (upsertAgentMount no-ops), so only block a genuine conflict: another volume
    // or bind already occupying the target on one of the selected Agents.
    if (selected.some((agent) => duplicateTarget(agent, target, yaml, existingKey))) { error = '所选 Agent 中已有 Agent 在该挂载目标上挂载了其他卷或目录'; return; }
    const committed = await commit((current) => {
      let next = current;
      for (const agent of selected) next = upsertAgentMount(next, agent, { type: 'volume', source: existingKey, target, read_only: false });
      return next;
    }, `已将卷挂载到 ${selected.length} 个 Agent`);
    if (committed) operationModal = '';
  }
  async function unmount(mount: AgentMount) { await commit((current) => removeAgentMount(current, mount.agent, mount.source, mount.target), '已卸载；卷声明和数据均已保留'); }
  async function togglePreset(name: keyof typeof CACHE_PRESETS, agent: string) {
    const preset = CACHE_PRESETS[name]; const declaration = preset.suffix; const found = resources.find((r) => r.key === declaration)?.mounts.find((m) => m.agent === agent && m.target === preset.target);
    if (found) { await unmount(found); return; }
    if (duplicateTarget(agent, preset.target)) { error = '该 Agent 的挂载目标已被使用'; return; }
    const generation = contextGeneration; const key = projectKey; if (locked) return; busy = true; error = '';
    try {
      const systemName = await managedVolumeName(key, preset.suffix); if (generation !== contextGeneration || key !== projectKey) return;
      assertReusable(yaml, declaration, systemName);
      let next = upsertProjectVolume(yaml, declaration, { name: systemName, driver: 'local', labels: { 'agent-compose-ui.cache-preset': name, 'agent-compose-ui.project-key': key } });
      next = upsertAgentMount(next, agent, { type: 'volume', source: declaration, target: preset.target, read_only: false });
      await onYamlChange(next); if (generation === contextGeneration) status = `已启用 ${name} 缓存`;
    } catch (value) { if (generation === contextGeneration) error = message(value); } finally { busy = false; }
  }
  async function loadCatalog(key = projectKey) {
    const generation = ++catalogGeneration; catalogLoading = true; catalogError = '';
    try { const next = await sharedDirectoryApi.list(); if (generation === catalogGeneration && key === projectKey) { catalog = next; if (!next.some((e) => e.id === sharedId)) sharedId = next[0]?.id ?? ''; sharedReadOnly = true; } }
    catch (value) { if (generation === catalogGeneration && key === projectKey) { catalog = []; catalogError = message(value); } }
    finally { if (generation === catalogGeneration) catalogLoading = false; }
  }
  async function mountShared() {
    const entry = catalog.find((item) => item.id === sharedId);
    const selected = [...sharedAgents]; const target = sharedTarget.trim();
    if (!entry || selected.length === 0 || !validMountTarget(target)) { error = '请选择当前目录和至少一个 Agent，并输入符合命名格式的绝对路径'; return; }
    if (!sharedReadOnly && !entry.writable) { error = '该共享目录不允许写入'; return; }
    if (selected.some((agent) => duplicateTarget(agent, target))) { error = '所选 Agent 中已有 Agent 使用了该挂载目标'; return; }
    const committed = await commit((current) => {
      const currentEntry = catalog.find((item) => item.id === sharedId); if (!currentEntry || currentEntry.path !== entry.path) throw new Error('共享目录目录已变化，请重试');
      let next = current;
      for (const agent of selected) next = upsertAgentMount(next, agent, { type: 'bind', source: currentEntry.path, target, read_only: sharedReadOnly });
      return next;
    }, `已将共享目录挂载到 ${selected.length} 个 Agent`);
    if (committed) operationModal = '';
  }
  function refs(resource: ProjectDataResource) { return resource.mounts.map((mount) => `${mount.agent}\0${mount.source}\0${mount.target}`).sort(); }
  function requestRemove(resource: ProjectDataResource, trigger: HTMLButtonElement) { deletion = { resource, refs: refs(resource), revision: yaml }; deleteTrigger = trigger; void tick().then(() => cancelDelete?.focus()); }
  function closeDelete() { deletion = null; void tick().then(() => deleteTrigger?.focus()); }
  async function confirmRemove(deleteData = false) {
    if (!deletion) return; const opened = deletion; const resource = deriveProjectResources(yaml).find((item) => item.key === opened.resource.key);
    if (!resource) { error = '卷声明已变化，请重试'; deletion = null; return; }
    const currentRefs = refs(resource);
    if (currentRefs.length !== opened.refs.length || currentRefs.some((value, index) => value !== opened.refs[index])) {
      deletion = { resource, refs: currentRefs, revision: yaml }; error = '挂载引用已变化，请检查更新后的列表并再次确认'; await tick(); cancelDelete?.focus(); return;
    }
    const detach = async () => {
      let next = yaml;
      for (const mount of resource.mounts) next = removeAgentMount(next, mount.agent, mount.source, mount.target);
      await onYamlChange(removeProjectVolume(next, resource.key));
    };
    if (!deleteData) {
      await commit(() => { let next = yaml; for (const mount of resource.mounts) next = removeAgentMount(next, mount.agent, mount.source, mount.target); return removeProjectVolume(next, resource.key); }, '已移除 YAML 声明；实际卷数据已保留');
      if (!error) deletion = null;
      return;
    }
    if (!fileBrowsable(resource) || locked) { error = '只有当前项目的托管卷可以删除数据'; return; }
    const generation = contextGeneration; const key = projectKey;
    const attempt = ++cleanupAttempt;
    busy = true; error = ''; status = '';
    try {
      saveCleanup({ projectKey: key, volume: resource.systemName, declaration: resource.key, error: '', inFlight: true, attempt, sequence: attempt, observedYaml: yaml });
      const result = await deleteManagedVolume({
        detachYaml: detach,
        applyProject: onApply,
        removeVolume: async () => { await removePhysicalVolume(key, resource.systemName); },
      });
      if (result.status === 'removed') clearCleanup(key, resource.systemName);
      else saveCleanup({ projectKey: key, volume: resource.systemName, declaration: resource.key, error: result.error, inFlight: false, attempt, sequence: attempt, observedYaml: cleanups[cleanupKey(key, resource.systemName)]?.observedYaml ?? yaml });
      if (generation !== contextGeneration || key !== projectKey) return;
      deletion = null;
      if (result.status === 'removed') {
        if (cleanupUnsafe({ projectKey: key, volume: resource.systemName, declaration: resource.key, error: '', inFlight: false, attempt, sequence: attempt, observedYaml: yaml })) error = '卷数据已删除，但当前 YAML 已包含同名声明或挂载；再次应用会创建新的卷';
        else status = '已移除声明并删除卷数据';
      }
    } catch (value) {
      clearCleanup(key, resource.systemName);
      if (generation === contextGeneration && key === projectKey) { deletion = null; error = `删除未完成：${message(value)}`; }
    }
    finally { busy = false; }
  }
  async function retryCleanup() {
    const cleanup = currentCleanup;
    if (!cleanup || cleanup.inFlight || locked) return;
    if (cleanupUnsafe(cleanup)) { clearCleanup(cleanup.projectKey, cleanup.volume); error = '待清理卷已重新声明或挂载，已取消数据删除'; return; }
    const identity = cleanupKey(cleanup.projectKey, cleanup.volume); const attempt = ++cleanupAttempt;
    saveCleanup({ ...cleanup, error: '', inFlight: true, attempt }); busy = true; error = '';
    try {
      await removePhysicalVolume(cleanup.projectKey, cleanup.volume);
      if (cleanups[identity]?.attempt === attempt) clearCleanup(cleanup.projectKey, cleanup.volume);
      if (projectKey === cleanup.projectKey) status = '卷数据已删除';
    }
    catch (value) {
      if (cleanups[identity]?.attempt === attempt) saveCleanup({ ...cleanup, error: message(value), inFlight: false, attempt });
    }
    finally { busy = false; }
  }
  async function apply() {
    if (locked) return; const generation = contextGeneration; const key = projectKey;
    applyBusy = true; applyStatus = ''; error = '';
    try { await onApply(); if (generation === contextGeneration && key === projectKey) { applyStatus = '应用成功'; volumeBrowserRevision += 1; } }
    catch (value) {
      const cancelled = value && typeof value === 'object' && (value as { code?: unknown }).code === 'apply_cancelled';
      if (!cancelled && generation === contextGeneration && key === projectKey) error = `应用失败：${message(value)}`;
    }
    finally { applyBusy = false; }
  }
  function dialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); closeDelete(); return; }
    if (event.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === cancelDelete) { event.preventDefault(); confirmDelete?.focus(); }
    else if (!event.shiftKey && document.activeElement === confirmDelete) { event.preventDefault(); cancelDelete?.focus(); }
  }
</script>

<section class="mount-panel" aria-label="数据与挂载" aria-hidden={deletion ? 'true' : undefined} inert={deletion ? true : undefined}>
  {#if error}<p role="alert">{error}</p>{/if}{#if currentCleanup?.inFlight}<p role={currentCleanup.error ? 'alert' : 'status'}>{currentCleanup.error || '正在删除卷数据…'}</p>{:else if currentCleanup?.error}<p role="alert">YAML 已应用，但卷数据删除失败：{currentCleanup.error} <button class="ui-button secondary" type="button" disabled={locked} onclick={retryCleanup}>重试删除数据</button></p>{/if}
  <div class="toolbar" role="toolbar" aria-label="数据与挂载操作"><button class="primary" type="button" disabled={!validKey || locked} onclick={() => operationModal = 'create'}>创建数据卷</button><button class="secondary" type="button" disabled={!validKey || locked} onclick={() => operationModal = 'mount'}>挂载资源</button>{#if status}<span class="inline-status" role="status">{status}</span>{/if}{#if applyStatus}<span class="inline-status" role="status">{applyStatus}</span>{/if}<span class="toolbar-spacer"></span><button class="ghost" type="button" disabled={!validKey || locked} onclick={apply}>{applyBusy ? '正在应用…' : '应用 YAML'}</button></div>
  <div class="resource-browser">
    <MountResourceList volumes={resources} {cacheKeys} shares={binds} selected={selection} onSelect={(value) => { selection = value; }} />
    <div class="resource-detail">
      <MountResourceDetail resource={selectedResource} share={selectedBind} {locked} canBrowse={!!selectedBrowsableVolume} onUnmount={(mount) => { void unmount(mount); }} onRemove={(resource, trigger) => requestRemove(resource, trigger)} />
      {#if selectedBrowsableVolume}{#key `${selectedBrowseKey}\0${selectedBrowsableVolume}\0${volumeBrowserRevision}`}<VolumeFileBrowser projectKey={selectedBrowseKey} volume={selectedBrowsableVolume} />{/key}{/if}
    </div>
  </div>
  {#if operationModal === 'create'}<div class="resource-modal-backdrop"><dialog class="resource-modal-card command-modal" open aria-label="创建数据卷"><form class="command-modal-form" onsubmit={(e) => { e.preventDefault(); if (createReady) void createVolume(); }}><div class="command-header"><div class="command-title"><h3>创建隔离持久卷</h3><span class="command-context">VOLUME / CREATE</span></div></div>
    <div class="command-fields">
      <label class="command-field">逻辑名称 <input aria-label="逻辑名称" aria-describedby={`${instanceId}-logical-help`} aria-invalid={logicalName.length > 0 && !logicalNameValid} bind:value={logicalName} /></label>
      <div class="command-field"><span>目标 Agent</span><details class="agent-multiselect"><summary aria-label="创建卷目标 Agent">{agentSelectionLabel(targetAgents)}</summary><div class="agent-options" role="group" aria-label="创建卷目标 Agent 选项">{#each agents as agent}<label><input type="checkbox" value={agent} bind:group={targetAgents} /> {agent}</label>{/each}</div></details></div>
      <label class="command-field">挂载目标 <input class="command-path" aria-label="创建卷挂载目标" aria-describedby={`${instanceId}-target-help`} aria-invalid={createTarget.length > 0 && !createTargetValid} bind:value={createTarget} oninput={() => targetTouched = true} /></label>
    </div>
    <div class="naming-help" id={`${instanceId}-logical-help`}>逻辑名称格式：以小写字母开头，只能包含小写字母、数字、下划线（_）和短横线（-），即 <code>^[a-z][a-z0-9_-]*$</code>。</div>
    <div class="naming-help" id={`${instanceId}-target-help`}>挂载目标格式：绝对路径，且每一级目录均符合上述命名格式，例如 <code>/data/project_memory</code>。</div>
    {#if logicalName.length > 0 && !logicalNameValid}<p class="field-error" role="alert">逻辑名称格式不正确</p>{/if}
    {#if createTarget.length > 0 && !createTargetValid}<p class="field-error" role="alert">挂载目标格式不正确</p>{/if}
    <div class="command-footer"><button class="ui-button ghost" type="button" onclick={() => operationModal = ''}>取消</button><button class="ui-button primary" disabled={!createReady}>创建并挂载</button></div>
  </form></dialog></div>{/if}
  {#if operationModal === 'mount'}<div class="resource-modal-backdrop"><dialog class="resource-modal-card command-modal" open aria-label="挂载资源"><div class="command-header"><div class="command-title"><h3>挂载资源</h3><span class="command-context">VOLUME / MOUNT</span></div><label class="command-field">资源类型 <select aria-label="资源类型" value={resourceType} onchange={(event) => { resourceType = event.currentTarget.value as typeof resourceType; }}><option value="volume">持久数据</option><option hidden value="cache">依赖缓存</option><option hidden value="share">共享目录</option></select></label></div>
  {#if resourceType === 'volume'}<form class="command-modal-form" onsubmit={(e) => { e.preventDefault(); void mountExisting(); }}>
    <div class="command-fields"><label class="command-field">卷 <select aria-label="现有卷" bind:value={existingKey}><option value="">请选择</option>{#each resources as r}<option value={r.key}>{r.key}</option>{/each}</select></label>
    <div class="command-field"><span>目标 Agent</span><details class="agent-multiselect"><summary aria-label="现有卷目标 Agent">{agentSelectionLabel(existingAgents)}</summary><div class="agent-options" role="group" aria-label="现有卷目标 Agent 选项">{#each agents as agent}<label><input type="checkbox" value={agent} bind:group={existingAgents} /> {agent}</label>{/each}</div></details></div><label class="command-field">挂载目标 <input class="command-path" aria-label="现有卷挂载目标" aria-invalid={existingTarget.length > 0 && !existingTargetValid} bind:value={existingTarget} /></label></div><div class="command-footer"><button class="ui-button ghost" type="button" onclick={() => operationModal = ''}>关闭</button><button class="ui-button primary" disabled={!mountReady}>挂载</button></div>
  </form>
  {:else if resourceType === 'cache'}<section class="command-modal-form"><label class="command-field">缓存预设 <select aria-label="缓存预设"><option>请选择下方预设</option></select></label><div class="command-presets">{#each agents as agent}<fieldset><legend>{agent}</legend>{#each Object.entries(CACHE_PRESETS) as [name, preset]}<button class="ui-button secondary" type="button" disabled={!validKey || locked} aria-pressed={resources.some((r) => r.key === preset.suffix && r.mounts.some((m) => m.agent === agent && m.target === preset.target))} onclick={() => togglePreset(name as keyof typeof CACHE_PRESETS, agent)}>{name} · {preset.target}</button>{/each}</fieldset>{/each}</div><div class="command-footer"><button class="ui-button ghost" type="button" onclick={() => operationModal = ''}>关闭</button></div></section>
  {:else}<form class="command-modal-form" onsubmit={(e) => { e.preventDefault(); void mountShared(); }}>
    {#if catalogLoading}<p class="command-status" role="status">正在加载共享目录…</p>{:else if catalogError}<p class="command-status" role="alert">加载失败：{catalogError} <button class="ui-button secondary" type="button" onclick={() => loadCatalog()}>重试</button></p>{/if}
    <div class="command-fields"><label class="command-field">目录 <select aria-label="共享目录" bind:value={sharedId} disabled={catalogLoading}><option value="">请选择</option>{#each catalog as entry}<option value={entry.id}>{entry.name} ({entry.writable ? '可写' : '只读'})</option>{/each}</select></label>
    <div class="command-field"><span>目标 Agent</span><details class="agent-multiselect"><summary aria-label="共享目录目标 Agent">{agentSelectionLabel(sharedAgents)}</summary><div class="agent-options" role="group" aria-label="共享目录目标 Agent 选项">{#each agents as agent}<label><input type="checkbox" value={agent} bind:group={sharedAgents} /> {agent}</label>{/each}</div></details></div><label class="command-field">挂载目标 <input class="command-path" aria-label="共享目录挂载目标" aria-invalid={sharedTarget.length > 0 && !sharedTargetValid} bind:value={sharedTarget} /></label>
    <label class="command-field"><input type="checkbox" aria-label="只读" bind:checked={sharedReadOnly} /> 只读</label></div><div class="command-footer">{#if selectedShared?.writable}<button class="ui-button secondary" type="button" onclick={() => sharedReadOnly = !sharedReadOnly}>{sharedReadOnly ? '允许写入' : '改为只读'}</button>{/if}<button class="ui-button ghost" type="button" onclick={() => operationModal = ''}>关闭</button><button class="ui-button primary" disabled={!validKey || locked || !sharedId || !sharedTargetValid || sharedAgents.length === 0}>挂载目录</button></div>
  </form>{/if}</dialog></div>{/if}
</section>

{#if deletion}
  <div class="backdrop" role="presentation"><div role="dialog" aria-modal="true" aria-labelledby={`${instanceId}-remove-title`} aria-describedby={`${instanceId}-remove-description`} tabindex="-1" onkeydown={dialogKeydown}>
    <h2 id={`${instanceId}-remove-title`}>移除卷声明 {deletion.resource.key}</h2><p>将从 YAML 卸载以下引用并移除声明：</p><ul>{#each deletion.resource.mounts as mount}<li>{mount.agent} → {mount.target}</li>{/each}</ul>
    <p id={`${instanceId}-remove-description`}>选择“仅移除”不会删除实际 daemon 卷数据；托管卷也可在实际应用 YAML 成功后删除数据。</p><button class="ui-button ghost" type="button" bind:this={cancelDelete} onclick={closeDelete}>取消</button><button class="ui-button secondary" type="button" bind:this={confirmDelete} disabled={busy} onclick={() => confirmRemove(false)}>仅移除并保留数据</button>{#if fileBrowsable(deletion.resource)}<button class="ui-button danger" type="button" disabled={busy} onclick={() => confirmRemove(true)}>删除数据并移除</button>{/if}
  </div></div>
{/if}

<style>
  .mount-panel{box-sizing:border-box;display:grid;flex:1;grid-template-rows:auto minmax(0,1fr);gap:12px;width:100%;min-width:0;min-height:0;padding:12px;overflow:hidden}.toolbar{display:flex;min-height:38px;align-items:center;gap:6px;margin:-12px -12px 0;padding:6px 10px;border-bottom:1px solid var(--border-color);background:var(--bg-secondary)}.toolbar-spacer{flex:1}.inline-status{overflow:hidden;color:var(--accent-green);font-size:var(--font-size-sm);text-overflow:ellipsis;white-space:nowrap}.toolbar button{height:27px;padding:3px 10px;border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);background:var(--bg-tertiary);font-size:var(--font-size-sm);cursor:pointer}.toolbar button:hover:not(:disabled){border-color:var(--accent-blue);color:var(--accent-blue)}.toolbar button:focus-visible{outline:2px solid var(--accent-blue);outline-offset:1px}.toolbar button:disabled{cursor:not-allowed;opacity:.5}.toolbar .primary{border-color:var(--accent-blue-emphasis);color:var(--text-on-accent);background:var(--accent-blue-emphasis);font-weight:600}.toolbar .primary:hover:not(:disabled){border-color:var(--accent-blue-emphasis);background:color-mix(in srgb,var(--accent-blue-emphasis) 88%,var(--bg-primary))}.toolbar .secondary{background:var(--bg-tertiary)}.toolbar .ghost{padding-inline:8px;border-color:transparent;color:var(--text-secondary);background:transparent}.toolbar .ghost:hover:not(:disabled){border-color:var(--border-color);color:var(--text-primary);background:var(--bg-tertiary)}.resource-browser{display:grid;grid-template-columns:minmax(210px,28%) minmax(0,1fr);height:100%;min-height:0;overflow:hidden;border:1px solid var(--border-color)}.resource-detail{min-width:0;min-height:0;overflow:auto}dialog{width:min(620px,100%)}form,section section{border:1px solid var(--border-color);padding:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}h3{width:100%;margin:0}label{display:grid;gap:3px}.command-modal .command-modal-form{display:grid;gap:10px;padding:0;border:0}.command-modal .command-field{display:flex;align-items:center;gap:7px}.command-modal .command-presets{display:grid}.command-modal .command-presets fieldset{display:flex;padding:7px}.agent-multiselect{position:relative;min-width:0;flex:1}.agent-multiselect summary{padding:6px 28px 6px 8px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-primary);cursor:pointer;list-style:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-multiselect summary::-webkit-details-marker{display:none}.agent-multiselect summary::after{position:absolute;right:9px;content:'⌄'}.agent-options{position:absolute;z-index:5;top:calc(100% + 4px);right:0;left:0;display:grid;max-height:180px;gap:2px;overflow:auto;padding:6px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-primary);box-shadow:0 8px 20px #0005}.agent-options label{display:flex;align-items:center;gap:7px;padding:5px}.naming-help{color:var(--text-muted);font-size:var(--font-size-xs);line-height:1.5}.naming-help code{color:var(--text-secondary)}.field-error{margin:0;color:var(--accent-red);font-size:var(--font-size-xs)}input[aria-invalid=true]{border-color:var(--accent-red)}button,input,select{font:inherit}.backdrop{position:fixed;inset:0;background:#0008;display:grid;place-items:center;z-index:100}.backdrop>[role=dialog]{background:var(--bg-primary);padding:20px;max-width:520px;border:1px solid var(--border-color)}
</style>
