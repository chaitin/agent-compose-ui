<script lang="ts">
  import { onMount } from 'svelte';
  import * as Tabs from '$lib/components/ui/tabs';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import CodeEditor from '$lib/components/code-editor.svelte';
  import { preloadMonaco } from '$lib/monaco';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import TokenManagement from '$lib/components/token-management.svelte';
  import { navigate } from '$lib/router.svelte';
  import { t } from '$lib/i18n.svelte';
  import { getAuthStatus, type AuthStatus } from '../api/auth';
  import {
    createWorkspacePreset,
    deleteWebhookSource,
    deleteWorkspacePreset,
    getCapabilityGatewayConfig,
    getCapabilityStatus,
    listEnvItems,
    listWebhookSources,
    listWorkspacePresets,
    saveWebhookSource,
    updateCapabilityGatewayConfig,
    updateEnvItems,
    updateWorkspacePreset,
    type CapabilityStatus,
    type EnvItem,
    type WebhookSource,
    type WorkspacePreset,
  } from '../api/config';

  let envItems = $state<EnvItem[]>([]);
  let workspaces = $state<WorkspacePreset[]>([]);
  let webhooks = $state<WebhookSource[]>([]);
  let auth = $state<AuthStatus | null>(null);
  let gatewayAddr = $state('');
  let gatewayToken = $state('');
  let gatewayTokenSet = $state(false);
  let gatewayClearToken = $state(false);
  let gatewayStatus = $state<CapabilityStatus | null>(null);
  let workspaceName = $state('');
  let workspaceType = $state('git');
  let workspaceConfig = $state('{}');
  let workspaceComment = $state('');
  let editingWorkspaceId = $state('');
  let webhookId = $state('');
  let webhookName = $state('');
  let webhookProvider = $state('github');
  let webhookTopic = $state('webhook.github.');
  let webhookEnabled = $state(true);
  let webhookToken = $state('');
  let webhookSignatureType = $state('');
  let webhookSignatureSecret = $state('');
  let webhookBodyLimit = $state(1048576);
  let editingWebhook = $state(false);
  let busy = $state(false);
  let error = $state('');
  let success = $state('');
  let activeTab = $state('env');

  onMount(load);

  async function load(): Promise<void> {
    busy = true;
    error = '';
    try {
      const [env, presets, sources, gateway, capabilityStatus, authStatus] = await Promise.all([
        listEnvItems(),
        listWorkspacePresets(),
        listWebhookSources(),
        getCapabilityGatewayConfig(),
        getCapabilityStatus(),
        getAuthStatus(),
      ]);
      envItems = env;
      workspaces = presets;
      webhooks = sources;
      gatewayAddr = gateway.addr;
      gatewayTokenSet = gateway.tokenSet;
      gatewayStatus = capabilityStatus;
      auth = authStatus;
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }

  function addEnv(): void {
    envItems = [...envItems, { name: '', value: '', secret: false, valueKnown: true }];
  }
  function removeEnv(index: number): void {
    envItems = envItems.filter((_, itemIndex) => itemIndex !== index);
  }
  function updateEnv(index: number, update: Partial<EnvItem>): void {
    envItems = envItems.map((item, itemIndex) => (itemIndex === index ? { ...item, ...update } : item));
  }

  async function saveEnv(): Promise<void> {
    await perform(t('全局环境已保存'), () => updateEnvItems(envItems));
  }
  async function saveGateway(): Promise<void> {
    await perform(t('能力网关已保存'), async () => {
      const tokenUpdate = gatewayClearToken ? '' : gatewayToken ? gatewayToken : undefined;
      const result = await updateCapabilityGatewayConfig(gatewayAddr, tokenUpdate);
      gatewayTokenSet = result.tokenSet;
      gatewayToken = '';
      gatewayClearToken = false;
      gatewayStatus = await getCapabilityStatus();
    });
  }

  async function testGateway(): Promise<void> {
    await perform(t('能力网关状态已刷新'), async () => {
      gatewayStatus = await getCapabilityStatus();
      if (!gatewayStatus.ok) throw new Error(gatewayStatus.error || gatewayStatus.status || t('能力网关连接失败'));
    });
  }

  async function createWorkspace(): Promise<void> {
    try {
      JSON.parse(workspaceConfig || '{}');
    } catch {
      error = t('Workspace 配置必须是有效 JSON');
      return;
    }
    await perform(t('Workspace 预设已创建'), async () => {
      const input = {
        name: workspaceName,
        type: workspaceType,
        configJson: workspaceConfig,
        comment: workspaceComment,
      };
      if (editingWorkspaceId) await updateWorkspacePreset(editingWorkspaceId, input);
      else await createWorkspacePreset(input);
      resetWorkspaceDraft();
      workspaces = await listWorkspacePresets();
    });
  }

  function editWorkspace(item: WorkspacePreset): void {
    editingWorkspaceId = item.id;
    workspaceName = item.name;
    workspaceType = item.type;
    workspaceConfig = item.configJson;
    workspaceComment = item.comment;
  }

  function resetWorkspaceDraft(): void {
    editingWorkspaceId = '';
    workspaceName = '';
    workspaceType = 'git';
    workspaceConfig = '{}';
    workspaceComment = '';
  }

  async function removeWorkspace(item: WorkspacePreset): Promise<void> {
    if (!confirm(`确认删除 Workspace 预设 ${item.name}？`)) return;
    await perform(t('Workspace 预设已删除'), async () => {
      await deleteWorkspacePreset(item.id);
      workspaces = await listWorkspacePresets();
    });
  }

  async function createWebhook(): Promise<void> {
    if (!webhookId.trim() || !webhookName.trim()) {
      error = t('Webhook ID 与名称必填');
      return;
    }
    await perform(t('Webhook 来源已保存'), async () => {
      await saveWebhookSource(webhookId.trim(), {
        name: webhookName,
        enabled: webhookEnabled,
        provider: webhookProvider,
        topicPrefix: webhookTopic,
        token: webhookToken,
        clearToken: false,
        signatureType: webhookSignatureType,
        signatureSecret: webhookSignatureSecret,
        clearSignature: false,
        bodyLimitBytes: webhookBodyLimit,
      });
      resetWebhookDraft();
      webhooks = await listWebhookSources();
    });
  }

  function editWebhook(item: WebhookSource): void {
    webhookId = item.id;
    webhookName = item.name;
    webhookProvider = item.provider;
    webhookTopic = item.topicPrefix;
    webhookEnabled = item.enabled;
    webhookToken = '';
    webhookSignatureType = item.signatureType;
    webhookSignatureSecret = '';
    webhookBodyLimit = item.bodyLimitBytes;
    editingWebhook = true;
  }

  function resetWebhookDraft(): void {
    webhookId = '';
    webhookName = '';
    webhookProvider = 'github';
    webhookTopic = 'webhook.github.';
    webhookEnabled = true;
    webhookToken = '';
    webhookSignatureType = '';
    webhookSignatureSecret = '';
    webhookBodyLimit = 1048576;
    editingWebhook = false;
  }

  async function removeWebhook(item: WebhookSource): Promise<void> {
    if (!confirm(`确认删除 Webhook 来源 ${item.name}？`)) return;
    await perform(t('Webhook 来源已删除'), async () => {
      await deleteWebhookSource(item.id);
      webhooks = await listWebhookSources();
    });
  }

  async function perform(message: string, action: () => Promise<void>): Promise<void> {
    busy = true;
    error = '';
    success = '';
    try {
      await action();
      success = message;
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }

  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : t('请求失败'));
</script>

<div data-page-layout="workbench" class="flex h-full min-h-0 flex-col overflow-hidden">
  <PageHeader title="设置" description="全局环境、能力网关、Webhook、Workspace、API Token 与鉴权" />
  <PageContent class="flex min-h-0 flex-1 flex-col overflow-hidden">
    {#if error}<div class="mb-4 shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </div>{/if}{#if success}<div class="mb-4 shrink-0 rounded-md bg-success/10 p-3 text-sm text-success">
        {success}
      </div>{/if}<Tabs.Root
      class="flex min-h-0 flex-1 flex-col overflow-hidden"
      value={activeTab}
      onValueChange={(value) => (activeTab = value)}
      ><Tabs.List data-scroll-surface class="shrink-0 max-w-full justify-start overflow-x-auto"
        ><Tabs.Trigger value="env">{t('全局环境')}</Tabs.Trigger><Tabs.Trigger value="gateway"
          >{t('能力网关')}</Tabs.Trigger
        ><Tabs.Trigger value="webhook">Webhook</Tabs.Trigger><Tabs.Trigger
          value="workspace"
          onpointerenter={preloadMonaco}
          onfocus={preloadMonaco}>{t('Workspace 预设')}</Tabs.Trigger
        ><Tabs.Trigger value="tokens">API Token</Tabs.Trigger><Tabs.Trigger value="auth">{t('鉴权')}</Tabs.Trigger
        ></Tabs.List
      >
      <Tabs.Content data-scroll-pane value="env" class="mt-4 min-h-0 max-w-3xl flex-1 space-y-3 overflow-y-auto pr-1"
        >{#each envItems as item, index (index)}<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto]">
            <Input
              value={item.name}
              oninput={(event) => updateEnv(index, { name: event.currentTarget.value })}
              placeholder="KEY"
            /><Input
              value={item.valueKnown ? item.value : ''}
              oninput={(event) => updateEnv(index, { value: event.currentTarget.value, valueKnown: true })}
              type={item.secret ? 'password' : 'text'}
              placeholder={item.secret && !item.valueKnown ? t('未修改') : 'value'}
            /><label class="flex items-center gap-1 text-xs"
              ><input
                type="checkbox"
                checked={item.secret}
                onchange={(event) => updateEnv(index, { secret: event.currentTarget.checked })}
              />Secret</label
            ><Button variant="ghost" size="sm" onclick={() => removeEnv(index)}>{t('移除')}</Button>
          </div>{/each}
        <div class="flex gap-2">
          <Button variant="outline" size="sm" onclick={addEnv}>{t('添加变量')}</Button><Button
            size="sm"
            disabled={busy}
            onclick={saveEnv}>{t('保存')}</Button
          >
        </div></Tabs.Content
      >
      <Tabs.Content data-scroll-pane value="tokens" class="mt-4 min-h-0 flex-1 overflow-y-auto pr-1"
        ><TokenManagement /></Tabs.Content
      >
      <Tabs.Content
        data-scroll-pane
        value="gateway"
        class="mt-4 min-h-0 max-w-2xl flex-1 space-y-4 overflow-y-auto pr-1"
        ><div class="rounded-lg border border-border bg-card p-4 text-sm">
          <div class="flex items-center gap-2">
            <span class="inline-block size-2 rounded-full {gatewayStatus?.ok ? 'bg-success' : 'bg-destructive'}"></span>
            <span>{t(gatewayStatus?.ok ? 'OctoBus 已连接' : 'OctoBus 未连接')}</span>
            <span class="text-muted-foreground">· {gatewayStatus?.serviceCount ?? 0} {t('个服务')}</span>
          </div>
          {#if gatewayStatus?.error}<p class="mt-2 text-destructive">{gatewayStatus.error}</p>{/if}
        </div>
        <label class="block space-y-1"
          ><span class="text-sm">{t('网关地址')}</span><Input bind:value={gatewayAddr} /></label
        ><label class="block space-y-1"
          ><span class="text-sm">{t('访问 Token')}</span><Input
            bind:value={gatewayToken}
            type="password"
            placeholder={t(gatewayTokenSet ? '已设置；留空保持不变' : '可选')}
          /></label
        >{#if gatewayTokenSet}<label class="flex items-center gap-2 text-sm"
            ><input type="checkbox" bind:checked={gatewayClearToken} />{t('清除已保存 Token')}</label
          >{/if}
        <div class="flex gap-2">
          <Button onclick={saveGateway} disabled={busy}>{t('保存网关')}</Button><Button
            variant="outline"
            onclick={testGateway}
            disabled={busy}>{t('测试连接')}</Button
          >
        </div></Tabs.Content
      >
      <Tabs.Content data-scroll-pane value="webhook" class="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1"
        ><div class="flex items-center justify-between">
          <div>
            <h2 class="text-sm font-medium">{t('Webhook 来源')}</h2>
            <p class="text-xs text-muted-foreground">{t('配置入口鉴权后，可在事件中心查询真实投递和关联运行。')}</p>
          </div>
          <Button variant="outline" size="sm" onclick={() => navigate('/events')}>{t('打开事件中心')}</Button>
        </div>
        <form
          class="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-2 xl:grid-cols-4"
          onsubmit={(event) => {
            event.preventDefault();
            void createWebhook();
          }}
        >
          <Input bind:value={webhookId} placeholder={t('唯一 ID')} disabled={editingWebhook} /><Input
            bind:value={webhookName}
            placeholder={t('名称')}
          /><Input bind:value={webhookProvider} placeholder="Provider" /><Input
            bind:value={webhookTopic}
            placeholder={t('Topic 前缀')}
          /><Input bind:value={webhookToken} type="password" placeholder={t('访问 Token（留空保持）')} /><Input
            bind:value={webhookSignatureType}
            placeholder={t('签名类型，如 hmac-sha256')}
          /><Input bind:value={webhookSignatureSecret} type="password" placeholder={t('签名密钥（留空保持）')} /><label
            class="flex items-center gap-2 text-sm"
            ><span>{t('Body 上限')}</span><Input bind:value={webhookBodyLimit} type="number" /></label
          ><label class="flex items-center gap-2 text-sm"
            ><input type="checkbox" bind:checked={webhookEnabled} />{t('启用')}</label
          >
          <div class="flex gap-2">
            <Button type="submit">{t(editingWebhook ? '保存修改' : '添加来源')}</Button>{#if editingWebhook}<Button
                type="button"
                variant="outline"
                onclick={resetWebhookDraft}>{t('取消')}</Button
              >{/if}
          </div>
        </form>
        {#each webhooks as item (item.id)}<div
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
          >
            <div>
              <div class="font-medium">{item.name}</div>
              <div class="text-xs text-muted-foreground">
                {item.provider} · {item.topicPrefix} · {t(item.enabled ? '启用' : '停用')}
              </div>
            </div>
            <div class="flex">
              <Button variant="ghost" size="sm" onclick={() => editWebhook(item)}>{t('编辑')}</Button><Button
                variant="ghost"
                size="sm"
                class="text-destructive"
                onclick={() => removeWebhook(item)}>{t('删除')}</Button
              >
            </div>
          </div>{:else}<p class="text-sm text-muted-foreground">{t('没有 Webhook 来源')}</p>{/each}</Tabs.Content
      >
      <Tabs.Content value="workspace" class="mt-4 min-h-0 flex-1 overflow-y-auto lg:overflow-hidden"
        ><div
          class="grid gap-4 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_19rem] xl:grid-cols-[minmax(0,1fr)_22rem]"
        >
          <form
            class="flex min-h-0 flex-col gap-3 rounded-lg border border-border p-4"
            onsubmit={(event) => {
              event.preventDefault();
              void createWorkspace();
            }}
          >
            <div class="grid gap-2 md:grid-cols-[1fr_12rem_2fr]">
              <Input bind:value={workspaceName} placeholder={t('名称')} /><select
                class="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                bind:value={workspaceType}><option value="git">git</option><option value="file">file</option></select
              ><Input bind:value={workspaceComment} placeholder={t('备注')} />
            </div>
            <div class="min-h-[20rem] lg:min-h-0 lg:flex-1">
              <CodeEditor bind:value={workspaceConfig} language="json" height="100%" title={t('Workspace 配置 JSON')} />
            </div>
            <div class="flex shrink-0 gap-2">
              <Button type="submit">{t(editingWorkspaceId ? '保存修改' : '创建')}</Button
              >{#if editingWorkspaceId}<Button type="button" variant="outline" onclick={resetWorkspaceDraft}
                  >{t('取消编辑')}</Button
                >{/if}
            </div>
          </form>
          <aside data-scroll-pane class="space-y-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <div class="flex items-center justify-between">
              <div>
                <h2 class="text-sm font-medium">{t('已有预设')}</h2>
                <p class="text-xs text-muted-foreground">{workspaces.length} 个 Workspace</p>
              </div>
              {#if editingWorkspaceId}<Button variant="outline" size="sm" onclick={resetWorkspaceDraft}
                  >{t('新建')}</Button
                >{/if}
            </div>
            {#each workspaces as item (item.id)}<div
                class="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-4"
              >
                <div>
                  <div class="font-medium">{item.name}</div>
                  <div class="flex items-center gap-1 text-xs text-muted-foreground">
                    <span>{item.type} ·</span><CopyableText value={item.id} label="Workspace ID" class="max-w-56" />
                  </div>
                  {#if item.comment}<div class="text-xs text-muted-foreground">{item.comment}</div>{/if}
                  <pre class="mt-2 whitespace-pre-wrap break-words text-xs">{item.configJson}</pre>
                </div>
                <div class="flex">
                  <Button variant="ghost" size="sm" onclick={() => editWorkspace(item)}>{t('编辑')}</Button><Button
                    variant="ghost"
                    size="sm"
                    class="text-destructive"
                    onclick={() => removeWorkspace(item)}>{t('删除')}</Button
                  >
                </div>
              </div>{:else}<p class="text-sm text-muted-foreground">{t('没有 Workspace 预设')}</p>{/each}
          </aside>
        </div></Tabs.Content
      >
      <Tabs.Content
        data-scroll-pane
        value="auth"
        class="mt-4 min-h-0 max-w-2xl flex-1 overflow-y-auto rounded-lg border border-border p-4 text-sm"
        ><dl class="grid grid-cols-[8rem_1fr] gap-2">
          <dt class="text-muted-foreground">{t('认证')}</dt>
          <dd>{t(auth?.enabled ? '已启用' : '未启用')}</dd>
          <dt class="text-muted-foreground">{t('当前用户')}</dt>
          <dd>{auth?.user?.displayName || auth?.username || t('匿名')}</dd>
          <dt class="text-muted-foreground">{t('用户 ID')}</dt>
          <dd class="break-all font-mono text-xs">{auth?.user?.id || '—'}</dd>
          <dt class="text-muted-foreground">{t('认证来源')}</dt>
          <dd>{auth?.user?.source || '—'}{auth?.user?.authMethod ? ` · ${auth.user.authMethod}` : ''}</dd>
          <dt class="text-muted-foreground">OAuth</dt>
          <dd>{t(auth?.oauthEnabled ? '已启用' : '未启用')}</dd>
          <dt class="text-muted-foreground">{t('会话到期')}</dt>
          <dd>{auth?.expiresAt || '—'}</dd>
        </dl></Tabs.Content
      ></Tabs.Root
    >
  </PageContent>
</div>
