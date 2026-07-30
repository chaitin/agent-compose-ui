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

  interface Props { yaml: string; projectKey: string; selectedAgent?: string; onYamlChange: (yaml: string) => void | Promise<void>; onApply: () => Promise<void> }
  let { yaml, projectKey, selectedAgent = '', onYamlChange, onApply }: Props = $props();
  const validKey = $derived(/^ws_[0-9a-f]{32}$/.test(projectKey));
  let logicalName = $state(''); let targetAgent = $state(''); let createTarget = $state(''); let targetTouched = $state(false);
  let existingKey = $state(''); let existingAgent = $state(''); let existingTarget = $state('');
  let sharedId = $state(''); let sharedAgent = $state(''); let sharedTarget = $state(''); let sharedReadOnly = $state(true);
  let catalog = $state<SharedDirectory[]>([]); let catalogLoading = $state(false); let catalogError = $state(''); let catalogGeneration = 0;
  let busy = $state(false); let applyBusy = $state(false); let status = $state(''); let error = $state(''); let applyStatus = $state('');
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

  const agents = $derived(agentNames(yaml));
  const resources = $derived.by(() => { try { return deriveProjectResources(yaml); } catch { return []; } });
  const binds = $derived(bindMounts(yaml));
  const selectedShared = $derived(catalog.find((entry) => entry.id === sharedId));
  const currentCleanup = $derived(Object.values(cleanups).find((item) => item.projectKey === projectKey));
  const cacheKeys = $derived(Object.values(CACHE_PRESETS).map((preset) => preset.suffix));
  const selectedResource = $derived.by(() => { const current = selection; return current?.kind === 'volume' ? resources.find((item) => item.key === current.key) : undefined; });
  const selectedBind = $derived.by(() => { const current = selection; return current?.kind === 'share' ? binds.find((item) => item.source === current.source && item.agent === current.agent && item.target === current.target) : undefined; });
  const selectedBrowsableVolume = $derived(selectedResource && validKey && fileBrowsable(selectedResource) ? selectedResource.systemName : '');

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
    const names = agents; const preferred = selectedAgent && names.includes(selectedAgent) ? selectedAgent : names[0] ?? '';
    if (!names.includes(targetAgent)) targetAgent = preferred;
    if (!names.includes(existingAgent)) existingAgent = preferred;
    if (!names.includes(sharedAgent)) sharedAgent = preferred;
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
  function identityTarget(path: string): string {
    const parts: string[] = [];
    for (const part of path.trim().split('/')) { if (!part || part === '.') continue; if (part === '..') parts.pop(); else parts.push(part); }
    return `/${parts.join('/')}`;
  }
  function absolute(path: string) { return canonicalAbsolute(path) !== null; }
  function duplicateTarget(agent: string, target: string, text = yaml) {
    const normalized = identityTarget(target);
    return [...deriveProjectResources(text).flatMap((r) => r.mounts), ...bindMounts(text)]
      .some((mount) => mount.agent === agent && identityTarget(mount.target) === normalized);
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
  function fileBrowsable(resource: ProjectDataResource): boolean {
    try {
      const declarations = parseYamlObject(yaml).volumes;
      if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) return false;
      const declaration = (declarations as Record<string, unknown>)[resource.key];
      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) return false;
      const value = declaration as Record<string, unknown>; const labels = value.labels;
      return value.external !== true && value.driver === 'local' && !!labels && typeof labels === 'object' && !Array.isArray(labels)
        && (labels as Record<string, unknown>)['agent-compose-ui.managed'] === 'true'
        && (labels as Record<string, unknown>)['agent-compose-ui.project-key'] === projectKey;
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
    if (!validKey || locked) return; busy = true; error = ''; status = '';
    try {
      if (generation !== contextGeneration || key !== projectKey) throw new Error('项目上下文已变化');
      const next = build(yaml); await onYamlChange(next);
      if (generation === contextGeneration && key === projectKey) status = success;
    } catch (value) { if (generation === contextGeneration && key === projectKey) error = message(value); }
    finally { busy = false; }
  }
  async function createVolume() {
    const logical = logicalName.trim(); const agent = targetAgent; const target = createTarget.trim(); const generation = contextGeneration; const key = projectKey;
    if (!logical || !agent || !absolute(target)) { error = '请输入安全名称、Agent 和绝对 Linux 路径'; return; }
    if (duplicateTarget(agent, target)) { error = '该 Agent 的挂载目标已被使用'; return; }
    if (locked) return; busy = true; error = ''; status = '';
    try {
      const systemName = await managedVolumeName(key, logical);
      if (generation !== contextGeneration || key !== projectKey) return;
      const declaration = logical.toLowerCase().replace(/ +/g, '-');
      assertReusable(yaml, declaration, systemName);
      let next = upsertProjectVolume(yaml, declaration, { name: systemName, driver: 'local', labels: { 'agent-compose-ui.logical-name': declaration, 'agent-compose-ui.project-key': key } });
      if (duplicateTarget(agent, target, next)) throw new Error('该 Agent 的挂载目标已被使用');
      next = upsertAgentMount(next, agent, { type: 'volume', source: declaration, target, read_only: false });
      await onYamlChange(next); if (generation === contextGeneration && key === projectKey) status = `已创建 ${declaration}`;
    } catch (value) { if (generation === contextGeneration && key === projectKey) error = message(value); }
    finally { busy = false; }
  }
  async function mountExisting() {
    if (!existingKey || !existingAgent || !absolute(existingTarget.trim())) { error = '请选择卷、Agent 并输入绝对路径'; return; }
    if (duplicateTarget(existingAgent, existingTarget)) { error = '该 Agent 的挂载目标已被使用'; return; }
    await commit((current) => upsertAgentMount(current, existingAgent, { type: 'volume', source: existingKey, target: existingTarget.trim(), read_only: false }), '已挂载卷');
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
    if (!entry || !sharedAgent || !absolute(sharedTarget.trim())) { error = '请选择当前目录、Agent 并输入绝对路径'; return; }
    if (!sharedReadOnly && !entry.writable) { error = '该共享目录不允许写入'; return; }
    if (duplicateTarget(sharedAgent, sharedTarget)) { error = '该 Agent 的挂载目标已被使用'; return; }
    await commit((current) => {
      const currentEntry = catalog.find((item) => item.id === sharedId); if (!currentEntry || currentEntry.path !== entry.path) throw new Error('共享目录目录已变化，请重试');
      return upsertAgentMount(current, sharedAgent, { type: 'bind', source: currentEntry.path, target: sharedTarget.trim(), read_only: sharedReadOnly });
    }, '已挂载共享目录');
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
    try { await onApply(); if (generation === contextGeneration && key === projectKey) applyStatus = '应用成功'; }
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
  {#if error}<p role="alert">{error}</p>{/if}{#if currentCleanup?.inFlight}<p role={currentCleanup.error ? 'alert' : 'status'}>{currentCleanup.error || '正在删除卷数据…'}</p>{:else if currentCleanup?.error}<p role="alert">YAML 已应用，但卷数据删除失败：{currentCleanup.error} <button type="button" disabled={locked} onclick={retryCleanup}>重试删除数据</button></p>{/if}{#if status}<p role="status">{status}</p>{/if}{#if applyStatus}<p role="status">{applyStatus}</p>{/if}
  <div class="toolbar" role="toolbar" aria-label="数据与挂载操作"><button type="button" disabled={!validKey || locked} onclick={() => operationModal = 'create'}>创建数据卷</button><button type="button" disabled={!validKey || locked} onclick={() => operationModal = 'mount'}>挂载资源</button><span></span><button type="button" disabled={!validKey || locked} onclick={apply}>{applyBusy ? '正在应用…' : '应用 YAML'}</button></div>
  <div class="resource-browser">
    <MountResourceList volumes={resources} {cacheKeys} shares={binds} selected={selection} onSelect={(value) => { selection = value; }} />
    <div class="resource-detail">
      <MountResourceDetail resource={selectedResource} share={selectedBind} {locked} canBrowse={!!selectedBrowsableVolume} onUnmount={(mount) => { void unmount(mount); }} onRemove={(resource, trigger) => requestRemove(resource, trigger)} />
      {#if selectedBrowsableVolume}<VolumeFileBrowser projectKey={projectKey} volume={selectedBrowsableVolume} />{/if}
    </div>
  </div>
  {#if operationModal === 'create'}<dialog open aria-label="创建数据卷"><form onsubmit={(e) => { e.preventDefault(); void createVolume(); }}><h3>创建隔离持久卷</h3>
    <label>逻辑名称 <input aria-label="逻辑名称" bind:value={logicalName} /></label><label>目标 Agent <select aria-label="创建卷目标 Agent" bind:value={targetAgent}>{#each agents as a}<option value={a}>{a}</option>{/each}</select></label>
    <label>挂载目标 <input aria-label="创建卷挂载目标" bind:value={createTarget} oninput={() => targetTouched = true} /></label><button type="button" onclick={() => operationModal = ''}>取消</button><button disabled={!validKey || locked}>创建并挂载</button>
  </form></dialog>{/if}
  {#if operationModal === 'mount'}<dialog open aria-label="挂载资源"><label>资源类型 <select aria-label="资源类型" value={resourceType} onchange={(event) => { resourceType = event.currentTarget.value as typeof resourceType; }}><option value="volume">持久数据</option><option value="cache">依赖缓存</option><option value="share">共享目录</option></select></label>
  {#if resourceType === 'volume'}<form onsubmit={(e) => { e.preventDefault(); void mountExisting(); }}><h3>挂载现有卷</h3>
    <label>卷 <select aria-label="现有卷" bind:value={existingKey}><option value="">请选择</option>{#each resources as r}<option value={r.key}>{r.key}</option>{/each}</select></label>
    <label>目标 Agent <select aria-label="现有卷目标 Agent" bind:value={existingAgent}>{#each agents as a}<option value={a}>{a}</option>{/each}</select></label><label>挂载目标 <input aria-label="现有卷挂载目标" bind:value={existingTarget} /></label><button disabled={!validKey || locked}>挂载</button>
  </form>
  {:else if resourceType === 'cache'}<section><h3>缓存预设</h3><label>缓存预设 <select aria-label="缓存预设"><option>请选择下方预设</option></select></label>{#each agents as agent}<fieldset><legend>{agent}</legend>{#each Object.entries(CACHE_PRESETS) as [name, preset]}<button type="button" disabled={!validKey || locked} aria-pressed={resources.some((r) => r.key === preset.suffix && r.mounts.some((m) => m.agent === agent && m.target === preset.target))} onclick={() => togglePreset(name as keyof typeof CACHE_PRESETS, agent)}>{name} · {preset.target}</button>{/each}</fieldset>{/each}</section>
  {:else}<form onsubmit={(e) => { e.preventDefault(); void mountShared(); }}><h3>共享目录</h3>
    {#if catalogLoading}<p role="status">正在加载共享目录…</p>{:else if catalogError}<p role="alert">加载失败：{catalogError} <button type="button" onclick={() => loadCatalog()}>重试</button></p>{/if}
    <label>目录 <select aria-label="共享目录" bind:value={sharedId} disabled={catalogLoading}><option value="">请选择</option>{#each catalog as entry}<option value={entry.id}>{entry.name} ({entry.writable ? '可写' : '只读'})</option>{/each}</select></label>
    <label>目标 Agent <select aria-label="共享目录目标 Agent" bind:value={sharedAgent}>{#each agents as a}<option value={a}>{a}</option>{/each}</select></label><label>挂载目标 <input aria-label="共享目录挂载目标" bind:value={sharedTarget} /></label>
    <label><input type="checkbox" aria-label="只读" bind:checked={sharedReadOnly} /> 只读</label>{#if selectedShared?.writable}<button type="button" onclick={() => sharedReadOnly = !sharedReadOnly}>{sharedReadOnly ? '允许写入' : '改为只读'}</button>{/if}<button disabled={!validKey || locked || !sharedId}>挂载目录</button>
  </form>{/if}<button type="button" onclick={() => operationModal = ''}>关闭</button></dialog>{/if}
</section>

{#if deletion}
  <div class="backdrop" role="presentation"><div role="dialog" aria-modal="true" aria-labelledby={`${instanceId}-remove-title`} aria-describedby={`${instanceId}-remove-description`} tabindex="-1" onkeydown={dialogKeydown}>
    <h2 id={`${instanceId}-remove-title`}>移除卷声明 {deletion.resource.key}</h2><p>将从 YAML 卸载以下引用并移除声明：</p><ul>{#each deletion.resource.mounts as mount}<li>{mount.agent} → {mount.target}</li>{/each}</ul>
    <p id={`${instanceId}-remove-description`}>选择“仅移除”不会删除实际 daemon 卷数据；托管卷也可在实际应用 YAML 成功后删除数据。</p><button type="button" bind:this={cancelDelete} onclick={closeDelete}>取消</button><button type="button" bind:this={confirmDelete} disabled={busy} onclick={() => confirmRemove(false)}>仅移除并保留数据</button>{#if fileBrowsable(deletion.resource)}<button type="button" disabled={busy} onclick={() => confirmRemove(true)}>删除数据并移除</button>{/if}
  </div></div>
{/if}

<style>
  .mount-panel{padding:12px;overflow:auto;display:grid;gap:12px}.toolbar{display:flex;gap:8px}.toolbar span{flex:1}.resource-browser{display:grid;grid-template-columns:minmax(210px,28%) 1fr;min-height:260px;border:1px solid var(--border-color)}.resource-detail{min-width:0;overflow:auto}dialog{width:min(620px,90vw);color:inherit;background:var(--bg-primary);border:1px solid var(--border-color)}form,section section{border:1px solid var(--border-color);padding:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}h3{width:100%;margin:0}label{display:grid;gap:3px}button,input,select{font:inherit}.backdrop{position:fixed;inset:0;background:#0008;display:grid;place-items:center;z-index:100}.backdrop>[role=dialog]{background:var(--bg-primary);padding:20px;max-width:520px;border:1px solid var(--border-color)}
</style>
