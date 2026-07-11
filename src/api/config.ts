import { capabilityClient, settingsClient } from './client';
import { apiFetchJson } from './http';

export type CapabilityGatewayConfig = {
  addr: string;
  tokenSet: boolean;
};

export type CapabilityStatus = {
  configured: boolean;
  ok: boolean;
  status: string;
  serviceCount: number;
  error: string;
  runtimeConfigured: boolean;
  proxyListenConfigured: boolean;
  proxyTargetConfigured: boolean;
};

export async function getCapabilityGatewayConfig(): Promise<CapabilityGatewayConfig> {
  const response = await settingsClient.getCapabilityGatewayConfig({});
  return { addr: response.config?.addr ?? '', tokenSet: response.config?.tokenSet ?? false };
}

// updateCapabilityGatewayConfig saves the OctoBus connection. An empty token
// clears the stored token.
export async function updateCapabilityGatewayConfig(addr: string, token: string): Promise<CapabilityGatewayConfig> {
  const response = await settingsClient.updateCapabilityGatewayConfig({ addr, token });
  return { addr: response.config?.addr ?? '', tokenSet: response.config?.tokenSet ?? false };
}

export async function getCapabilityStatus(): Promise<CapabilityStatus> {
  const response = await capabilityClient.getCapabilityStatus({});
  return {
    configured: response.configured,
    ok: response.ok,
    status: response.status,
    serviceCount: response.serviceCount,
    error: response.error,
    runtimeConfigured: response.runtimeConfigured,
    proxyListenConfigured: response.proxyListenConfigured,
    proxyTargetConfigured: response.proxyTargetConfigured,
  };
}

export type CapabilitySet = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
};

export async function listCapabilitySets(): Promise<CapabilitySet[]> {
  const response = await capabilityClient.listCapabilitySets({});
  return response.capsets.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    enabled: item.enabled,
  }));
}

export type CapabilityMethodInfo = {
  methodFullName: string;
  serviceId: string;
  instanceId: string;
  backendInstanceStatus: string;
};

export async function getCapabilityCatalog(capsetId: string): Promise<CapabilityMethodInfo[]> {
  const response = await capabilityClient.getCapabilityCatalog({ capsetId });
  return response.methods.map((method) => ({
    methodFullName: method.methodFullName,
    serviceId: method.serviceId,
    instanceId: method.instanceId,
    backendInstanceStatus: method.backendInstanceStatus,
  }));
}

export type EnvItem = {
  name: string;
  value: string;
  secret: boolean;
  valueKnown: boolean;
};

export type WorkspaceFileEntry = {
  path: string;
  dir: boolean;
  size: number;
  updatedAt: string;
};

export type WorkspacePreset = {
  id: string;
  name: string;
  type: string;
  configJson: string;
  comment: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspacePresetInput = {
  name: string;
  type: string;
  configJson: string;
  comment: string;
};

export type WebhookSource = {
  id: string;
  name: string;
  enabled: boolean;
  provider: string;
  topicPrefix: string;
  hasToken: boolean;
  signatureType: string;
  hasSignatureSecret: boolean;
  bodyLimitBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type WebhookSourceInput = {
  name: string;
  enabled: boolean;
  provider: string;
  topicPrefix: string;
  token: string;
  clearToken: boolean;
  signatureType: string;
  signatureSecret: string;
  clearSignature: boolean;
  bodyLimitBytes: number;
};

type WebhookSourceResponseItem = {
  id: string;
  name: string;
  enabled: boolean;
  provider: string;
  topic_prefix: string;
  has_token: boolean;
  signature_type?: string;
  has_signature_secret?: boolean;
  body_limit_bytes: number;
  created_at: string;
  updated_at: string;
};

type WebhookSourceListResponse = {
  items?: WebhookSourceResponseItem[];
};

type WebhookSourceResponse = {
  source?: WebhookSourceResponseItem;
};

export async function listEnvItems(): Promise<EnvItem[]> {
  const response = await settingsClient.getGlobalEnv({});
  return response.env.map((item) => ({
    name: item.name,
    value: item.secret && item.value ? '' : item.value,
    secret: item.secret,
    valueKnown: !item.secret || !item.value,
  }));
}

export async function updateEnvItems(envItems: EnvItem[]): Promise<void> {
  await settingsClient.updateGlobalEnv({
    env: envItems
      .filter((item) => item.name.trim())
      .map((item) => ({
        name: item.name.trim(),
        value: item.value,
        secret: item.secret,
      })),
  });
}

export async function listWorkspacePresets(): Promise<WorkspacePreset[]> {
  const response = await settingsClient.listWorkspacePresets({});
  return response.presets.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    configJson: item.configJson,
    comment: item.comment,
    createdAt: timestampString(item.createdAt),
    updatedAt: timestampString(item.updatedAt),
  }));
}

export async function createWorkspacePreset(input: WorkspacePresetInput): Promise<WorkspacePreset> {
  const response = await settingsClient.createWorkspacePreset({
    name: input.name.trim(),
    type: input.type,
    configJson: input.configJson,
    comment: input.comment.trim(),
  });
  if (!response.preset) {
    throw new Error('Workspace 配置保存失败');
  }
  return workspaceFromResponse(response.preset);
}

export async function updateWorkspacePreset(id: string, input: WorkspacePresetInput): Promise<WorkspacePreset> {
  const response = await settingsClient.updateWorkspacePreset({
    presetId: id,
    name: input.name.trim(),
    type: input.type,
    configJson: input.configJson,
    comment: input.comment.trim(),
  });
  if (!response.preset) {
    throw new Error('Workspace 配置保存失败');
  }
  return workspaceFromResponse(response.preset);
}

export async function deleteWorkspacePreset(id: string): Promise<void> {
  await settingsClient.deleteWorkspacePreset({ presetId: id });
}

type WorkspaceFilesResponse = {
  files?: Array<{ path: string; dir: boolean; size: number; updated_at: string }>;
};

function workspaceFilesFromResponse(response: WorkspaceFilesResponse): WorkspaceFileEntry[] {
  return (response.files ?? []).map((item) => ({
    path: item.path,
    dir: item.dir,
    size: item.size,
    updatedAt: item.updated_at,
  }));
}

export async function listWorkspaceFiles(workspaceId: string): Promise<WorkspaceFileEntry[]> {
  const response = await apiFetchJson<WorkspaceFilesResponse>(
    `/api/agent-compose/workspaces/${encodeURIComponent(workspaceId)}/files`,
  );
  return workspaceFilesFromResponse(response);
}

export async function uploadWorkspaceArchive(workspaceId: string, file: File): Promise<WorkspaceFileEntry[]> {
  const formData = new FormData();
  formData.set('upload_type', 'archive');
  formData.set('file', file);
  const response = await apiFetchJson<WorkspaceFilesResponse>(
    `/api/agent-compose/workspaces/${encodeURIComponent(workspaceId)}/upload`,
    { method: 'POST', body: formData },
  );
  return workspaceFilesFromResponse(response);
}

export async function listWebhookSources(): Promise<WebhookSource[]> {
  const response = await apiFetchJson<WebhookSourceListResponse>('/api/webhook-sources');
  return (response.items ?? []).map(webhookSourceFromResponse);
}

export async function saveWebhookSource(id: string, input: WebhookSourceInput): Promise<WebhookSource> {
  const response = await apiFetchJson<WebhookSourceResponse>(
    `/api/webhook-sources/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        name: input.name.trim(),
        enabled: input.enabled,
        provider: input.provider.trim(),
        topic_prefix: input.topicPrefix.trim(),
        token: input.token,
        clear_token: input.clearToken,
        signature_type: input.signatureType.trim(),
        signature_secret: input.signatureSecret,
        clear_signature: input.clearSignature,
        body_limit_bytes: input.bodyLimitBytes,
      }),
    },
  );
  if (!response.source) {
    throw new Error('Webhook 来源保存失败');
  }
  return webhookSourceFromResponse(response.source);
}

export async function deleteWebhookSource(id: string): Promise<void> {
  await apiFetch(`/api/webhook-sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

function workspaceFromResponse(item: NonNullable<Awaited<ReturnType<typeof settingsClient.createWorkspacePreset>>['preset']>): WorkspacePreset {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    configJson: item.configJson,
    comment: item.comment,
    createdAt: timestampString(item.createdAt),
    updatedAt: timestampString(item.updatedAt),
  };
}

function timestampString(value?: { seconds: bigint; nanos: number }): string {
  return value ? new Date(Number(value.seconds) * 1000 + value.nanos / 1e6).toISOString() : '';
}

function webhookSourceFromResponse(item: WebhookSourceResponseItem): WebhookSource {
  return {
    id: item.id,
    name: item.name,
    enabled: item.enabled,
    provider: item.provider,
    topicPrefix: item.topic_prefix,
    hasToken: item.has_token,
    signatureType: item.signature_type ?? '',
    hasSignatureSecret: item.has_signature_secret ?? false,
    bodyLimitBytes: item.body_limit_bytes,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}
