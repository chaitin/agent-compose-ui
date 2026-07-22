export type Page = 'dashboard' | 'project' | 'images' | 'environment' | 'caches' | 'volumes' | 'settings' | 'webhooks' | 'tokens' | 'session-detail';

export type RuntimeLevel =
  | 'agents'
  | 'project-runtime'
  | 'latest-run'
  | 'agent-sandboxes'
  | 'sandbox-detail'
  | 'schedulers'
  | 'agent-detail'
  | 'run-detail'
  | 'scheduler-run-detail'
  | 'session'
  | 'loader-runs'
  | 'loader-run-detail';

export interface RuntimeView {
  level: RuntimeLevel;
  agentName: string;
  runId: string;
  sessionId: string;
  sandboxId?: string;
  loaderId?: string;
  // Non-URL, in-memory only: which cell to focus when entering a session from a LoaderRun event.
  focusCellId?: string;
}

import type { ProjectEntry, ToastMessage } from './types';
import { EMPTY_YAML_TEMPLATE, yamlToSpec } from './yaml';

const LOCALSTORAGE_KEY = 'agent-compose-console';

function loadState(): { activeProjectId: string; editorContent: string } {
  try {
    const raw = localStorage.getItem(LOCALSTORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { activeProjectId: '', editorContent: '' };
}

function saveState(activeProjectId: string, editorContent: string) {
  try {
    localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify({ activeProjectId, editorContent }));
  } catch { /* ignore */ }
}

export function defaultNavigationURL(pathname: string): string {
  const eventPath = /(?:^|\/agent-compose)\/events\/[^/]+\/?$/.test(pathname);
  return eventPath
    ? `${pathname}#/project/new`
    : `${pathname}?sandboxTab=files#/project/new`;
}

// Per-project editor content cache. The backend stores the env-${VAR}-expanded
// spec, so without a local cache of the raw YAML, re-entering a project would
// show expanded values and lose `${VAR}` / `$ref:` references. These keys are
// the source of truth for what the user actually typed.
const PROJECT_EDITOR_PREFIX = 'editor:';
const NEW_PROJECT_DRAFT_ID = '__new_project_draft__';
const BROWSER_DRAFTS_KEY = 'editor:drafts:v1';

export interface BrowserDraft {
  id: string;
  name: string;
  content: string;
  updatedAt: string;
}

function draftName(content: string): string {
  return yamlToSpec(content).spec.name?.trim() || '未命名草稿';
}

function createDraftId(): string {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* use fallback */ }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function draftComposePath(id: string): string {
  return `/agent-compose-ui/projects/${encodeURIComponent(id)}/agent-compose.yml`;
}

function persistBrowserDrafts(drafts: BrowserDraft[]): void {
  try {
    localStorage.setItem(BROWSER_DRAFTS_KEY, JSON.stringify({ version: 1, drafts }));
  } catch { /* ignore */ }
}

export function loadBrowserDrafts(): BrowserDraft[] {
  try {
    const raw = localStorage.getItem(BROWSER_DRAFTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.drafts)) {
        return parsed.drafts.filter((draft: unknown): draft is BrowserDraft => (
          !!draft && typeof draft === 'object' &&
          typeof (draft as BrowserDraft).id === 'string' &&
          typeof (draft as BrowserDraft).content === 'string'
        )).map((draft: BrowserDraft) => ({ ...draft, name: draftName(draft.content) }));
      }
    }
    const legacy = localStorage.getItem(projectEditorKey(NEW_PROJECT_DRAFT_ID));
    if (!legacy) return [];
    const migrated = [{ id: createDraftId(), name: draftName(legacy), content: legacy, updatedAt: new Date().toISOString() }];
    persistBrowserDrafts(migrated);
    localStorage.removeItem(projectEditorKey(NEW_PROJECT_DRAFT_ID));
    return migrated;
  } catch {
    return [];
  }
}

function projectEditorKey(id: string): string {
  return `${PROJECT_EDITOR_PREFIX}${id}`;
}

function loadProjectEditor(id: string): string | null {
  try {
    return localStorage.getItem(projectEditorKey(id));
  } catch {
    return null;
  }
}

function saveProjectEditor(id: string, content: string): void {
  try {
    localStorage.setItem(projectEditorKey(id), content);
  } catch { /* ignore */ }
}

function removeProjectEditor(id: string): void {
  try {
    localStorage.removeItem(projectEditorKey(id));
  } catch { /* ignore */ }
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function parseHash(hash: string): {
  page: Page;
  projectId: string;
  runtimeView: RuntimeView;
} | null {
  // Strip leading #/ or #
  const path = hash.replace(/^#\/?/, '');
  if (!path) return null;

  const segments = path.split('/');

  // #/dashboard
  if (segments[0] === 'dashboard' && segments.length === 1) {
    return {
      page: 'dashboard',
      projectId: '',
      runtimeView: { level: 'agents', agentName: '', runId: '', sessionId: '' },
    };
  }

  // #/settings
  if (segments[0] === 'settings' && segments.length === 1) {
    return {
      page: 'settings',
      projectId: '',
      runtimeView: { level: 'agents', agentName: '', runId: '', sessionId: '' },
    };
  }

  if (segments[0] === 'system' && segments.length === 2) {
    const page = ({ images: 'images', environment: 'environment', capabilities: 'settings', webhooks: 'webhooks', tokens: 'tokens' } as const)[segments[1]];
    if (page) {
      return {
        page,
        projectId: '',
        runtimeView: { level: 'agents', agentName: '', runId: '', sessionId: '' },
      };
    }
  }

  if (segments[0] === 'resources' && segments[1] === 'images' && segments.length === 2) {
    return {
      page: 'images',
      projectId: '',
      runtimeView: { level: 'agents', agentName: '', runId: '', sessionId: '' },
    };
  }

  if (segments[0] === 'resources' && segments[1] === 'caches' && segments.length === 2) {
    return { page: 'caches', projectId: '', runtimeView: { level: 'agents', agentName: '', runId: '', sessionId: '' } };
  }

  if (segments[0] === 'resources' && segments[1] === 'volumes' && segments.length === 2) {
    return { page: 'volumes', projectId: '', runtimeView: { level: 'agents', agentName: '', runId: '', sessionId: '' } };
  }

  // #/project/...
  if (segments[0] === 'project' && segments.length >= 2) {
    const projectId = segments[1];

    // #/project/new
    if (projectId === 'new' && segments.length === 2) {
      return {
        page: 'project',
        projectId: '',
        runtimeView: { level: 'agents', agentName: '', runId: '', sessionId: '' },
      };
    }

    // #/project/<id>/agents
    if (segments.length === 3 && segments[2] === 'agents') {
      return {
        page: 'project',
        projectId,
        runtimeView: { level: 'agents', agentName: '', runId: '', sessionId: '' },
      };
    }

    // #/project/<id>/latest-run
    if (segments.length === 3 && segments[2] === 'latest-run') {
      return {
        page: 'project',
        projectId,
        runtimeView: { level: 'latest-run', agentName: '', runId: '', sessionId: '' },
      };
    }

    // #/project/<id>/runtime
    if (segments.length === 3 && segments[2] === 'runtime') {
      return {
        page: 'project',
        projectId,
        runtimeView: { level: 'project-runtime', agentName: '', runId: '', sessionId: '' },
      };
    }

    // #/project/<id>/sandbox/<sandboxId>
    if (segments.length === 4 && segments[2] === 'sandbox') {
      const sandboxId = safeDecode(segments[3]);
      if (sandboxId === null) return null;
      return {
        page: 'project',
        projectId,
        runtimeView: { level: 'sandbox-detail', sandboxId, agentName: '', runId: '', sessionId: '' },
      };
    }

    if (segments.length === 3 && segments[2] === 'schedulers') {
      return {
        page: 'project', projectId,
        runtimeView: { level: 'schedulers', agentName: '', runId: '', sessionId: '' },
      };
    }

    // #/project/<id>/loader-runs
    if (segments.length === 3 && segments[2] === 'loader-runs') {
      return {
        page: 'project',
        projectId,
        runtimeView: { level: 'loader-runs', agentName: '', runId: '', sessionId: '' },
      };
    }

    // #/project/<id>/loader-run/<loaderId>/<runId>[/session/<sessionId>]
    if (segments.length >= 5 && segments[2] === 'loader-run') {
      const loaderId = safeDecode(segments[3]);
      const runId = safeDecode(segments[4]);
      if (loaderId === null || runId === null) return null;

      // #/project/<id>/loader-run/<loaderId>/<runId>
      if (segments.length === 5) {
        return {
          page: 'project',
          projectId,
          runtimeView: { level: 'loader-run-detail', agentName: '', loaderId, runId, sessionId: '' },
        };
      }

      // #/project/<id>/loader-run/<loaderId>/<runId>/session/<sessionId>
      if (segments.length === 7 && segments[5] === 'session') {
        return {
          page: 'project',
          projectId,
          runtimeView: {
            level: 'session',
            agentName: '',
            loaderId,
            runId,
            sessionId: safeDecode(segments[6]) ?? '',
          },
        };
      }
    }

    // #/project/<id>/agent/<name>[/...]
    if (segments.length >= 4 && segments[2] === 'agent') {
      const agentName = safeDecode(segments[3]);
      if (agentName === null) return null;

      // #/project/<id>/agent/<name>
      if (segments.length === 4) {
        return {
          page: 'project',
          projectId,
          runtimeView: { level: 'agent-detail', agentName, runId: '', sessionId: '' },
        };
      }

      // #/project/<id>/agent/<name>/sandboxes
      if (segments.length === 5 && segments[4] === 'sandboxes') {
        return {
          page: 'project',
          projectId,
          runtimeView: { level: 'agent-sandboxes', agentName, runId: '', sessionId: '' },
        };
      }

      // #/project/<id>/agent/<name>/scheduler-run/<runId>
      if (segments.length === 6 && segments[4] === 'scheduler-run') {
        const runId = safeDecode(segments[5]);
        if (runId === null) return null;
        return {
          page: 'project', projectId,
          runtimeView: { level: 'scheduler-run-detail', agentName, runId, sessionId: '' },
        };
      }

      // #/project/<id>/agent/<name>/session/<sessionId>
      if (segments.length === 6 && segments[4] === 'session') {
        return {
          page: 'project',
          projectId,
          runtimeView: {
            level: 'session',
            agentName,
            runId: '',
            sessionId: safeDecode(segments[5]) ?? '',
          },
        };
      }

      // #/project/<id>/agent/<name>/run/<runId>[/session/<sessionId>]
      if (segments.length >= 6 && segments[4] === 'run') {
        const runId = safeDecode(segments[5]);
        if (runId === null) return null;

        // #/project/<id>/agent/<name>/run/<runId>
        if (segments.length === 6) {
          return {
            page: 'project',
            projectId,
            runtimeView: { level: 'run-detail', agentName, runId, sessionId: '' },
          };
        }

        // #/project/<id>/agent/<name>/run/<runId>/session/<sessionId>
        if (segments.length === 8 && segments[6] === 'session') {
          return {
            page: 'project',
            projectId,
            runtimeView: {
              level: 'session',
              agentName,
              runId,
              sessionId: safeDecode(segments[7]) ?? '',
            },
          };
        }
      }
    }
  }

  return null;
}

export function buildHash(page: Page, projectId: string, rv: RuntimeView): string {
  if (page === 'dashboard') return '#/dashboard';
  if (page === 'settings') return '#/system/capabilities';
  if (page === 'images') return '#/system/images';
  if (page === 'environment') return '#/system/environment';
  if (page === 'webhooks') return '#/system/webhooks';
  if (page === 'tokens') return '#/system/tokens';
  if (page === 'caches') return '#/resources/caches';
  if (page === 'volumes') return '#/resources/volumes';

  // project page
  if (!projectId) return '#/project/new';

  if (rv.level === 'agents') return `#/project/${projectId}/agents`;
  if (rv.level === 'project-runtime') return `#/project/${projectId}/runtime`;
  if (rv.level === 'latest-run') return `#/project/${projectId}/latest-run`;
  if (rv.level === 'schedulers') return `#/project/${projectId}/schedulers`;
  if (rv.level === 'loader-runs') return `#/project/${projectId}/loader-runs`;
  if (rv.level === 'loader-run-detail') {
    return `#/project/${projectId}/loader-run/${encodeURIComponent(rv.loaderId ?? '')}/${encodeURIComponent(rv.runId)}`;
  }
  if (rv.level === 'agent-detail') return `#/project/${projectId}/agent/${encodeURIComponent(rv.agentName)}`;
  if (rv.level === 'agent-sandboxes') return `#/project/${projectId}/agent/${encodeURIComponent(rv.agentName)}/sandboxes`;
  if (rv.level === 'sandbox-detail') return `#/project/${projectId}/sandbox/${encodeURIComponent(rv.sandboxId ?? '')}`;
  if (rv.level === 'run-detail') {
    return `#/project/${projectId}/agent/${encodeURIComponent(rv.agentName)}/run/${encodeURIComponent(rv.runId)}`;
  }
  if (rv.level === 'scheduler-run-detail') {
    return `#/project/${projectId}/agent/${encodeURIComponent(rv.agentName)}/scheduler-run/${encodeURIComponent(rv.runId)}`;
  }
  if (rv.level === 'session') {
    if (rv.loaderId) {
      return `#/project/${projectId}/loader-run/${encodeURIComponent(rv.loaderId)}/${encodeURIComponent(rv.runId)}/session/${encodeURIComponent(rv.sessionId)}`;
    }
    if (rv.runId) {
      return `#/project/${projectId}/agent/${encodeURIComponent(rv.agentName)}/run/${encodeURIComponent(rv.runId)}/session/${encodeURIComponent(rv.sessionId)}`;
    }
    return `#/project/${projectId}/agent/${encodeURIComponent(rv.agentName)}/session/${encodeURIComponent(rv.sessionId)}`;
  }
  return '#/dashboard';
}

export class Store {
  currentPage: Page = $state('dashboard');
  editorCollapsed = $state(false);
  splitRatio = $state(45);

  projects: ProjectEntry[] = $state([]);
  activeProjectId = $state('');
  editorContent = $state('');
  browserDrafts: BrowserDraft[] = $state(loadBrowserDrafts());
  activeDraftId = $state('');

  dashboardOverview: {
    runs?: { runningCount?: number; recentCount?: number; attentionCount?: number };
  } | null = $state(null);

  runtimeView: RuntimeView = $state({
    level: 'agents',
    agentName: '',
    runId: '',
    sessionId: '',
  });

  runtimeRefreshVersion = $state(0);
  sandboxReturnView: RuntimeView | null = null;

  toasts: ToastMessage[] = $state([]);
  toastId = 0;

  _syncing = false;

  constructor() {
    const saved = loadState();
    this.editorContent = saved.editorContent;

    // Try restoring navigation from URL hash first
    const parsed = parseHash(window.location.hash);
    if (parsed) {
      this.currentPage = parsed.page;
      const isNewProject = parsed.page === 'project' && !parsed.projectId;
      this.activeProjectId = isNewProject ? '' : parsed.projectId || saved.activeProjectId;
      if (isNewProject) this.editorContent = EMPTY_YAML_TEMPLATE;
      this.runtimeView = parsed.runtimeView;
    } else {
      this.currentPage = 'project';
      this.activeProjectId = '';
      this.editorContent = EMPTY_YAML_TEMPLATE;
      window.history.replaceState(null, '', defaultNavigationURL(window.location.pathname));
    }

    // Handle browser back/forward
    window.addEventListener('hashchange', () => {
      if (this._syncing) {
        this._syncing = false;
        return;
      }
      const parsed = parseHash(window.location.hash);
      if (parsed) {
        this.sandboxReturnView = null;
        this.currentPage = parsed.page;
        this.activeProjectId = parsed.page === 'project' && !parsed.projectId ? '' : parsed.projectId || this.activeProjectId;
        if (parsed.page === 'project' && !parsed.projectId) this.activeDraftId = '';
        this.runtimeView = parsed.runtimeView;
      }
    });
  }

  // Persist editor content to localStorage whenever it changes
  _persist = $effect.root(() => {
    $effect(() => {
      void this.editorContent; // track dependency
      void this.activeProjectId; // track dependency
      saveState(this.activeProjectId, this.editorContent);
    });
  });

  // Commit editor content produced by user editing/applying. Writes the raw
  // (unexpanded) YAML to a per-project cache so re-entering the project keeps
  // `${VAR}` / `$ref:` references instead of the backend-expanded snapshot.
  // Only persists when a project is active, so unsaved new-project templates
  // don't pollute an existing project's cache.
  commitEditorContent(value: string) {
    this.editorContent = value;
    if (this.activeProjectId) saveProjectEditor(this.activeProjectId, value);
  }

  loadProjectEditor(id: string): string | null {
    return loadProjectEditor(id);
  }

  removeProjectEditor(id: string) {
    removeProjectEditor(id);
  }

  saveProjectEditor(id: string, content: string) {
    saveProjectEditor(id, content);
  }

  saveEditorDraft() {
    if (this.activeProjectId) {
      saveProjectEditor(this.activeProjectId, this.editorContent);
      return { ok: true as const, draft: null };
    }
    const name = draftName(this.editorContent);
    const duplicate = this.browserDrafts.find((draft) => draft.id !== this.activeDraftId && draft.name === name);
    if (duplicate) return { ok: false as const, reason: 'duplicate-name' as const, name };
    const existing = this.browserDrafts.find((draft) => draft.id === this.activeDraftId);
    const draft: BrowserDraft = {
      id: existing?.id || this.activeDraftId || createDraftId(),
      name,
      content: this.editorContent,
      updatedAt: new Date().toISOString(),
    };
    this.browserDrafts = existing
      ? this.browserDrafts.map((item) => item.id === draft.id ? draft : item)
      : [...this.browserDrafts, draft];
    this.activeDraftId = draft.id;
    persistBrowserDrafts(this.browserDrafts);
    return { ok: true as const, draft };
  }

  ensureEditorDraftSourcePath(): string {
    if (this.activeProjectId) {
      return this.projects.find((project) => project.summary.projectId === this.activeProjectId)?.summary.sourcePath?.trim() || '';
    }
    if (!this.activeDraftId) this.activeDraftId = createDraftId();
    return draftComposePath(this.activeDraftId);
  }

  loadEditorDraft(id = this.activeDraftId): string | null {
    return this.activeProjectId ? loadProjectEditor(this.activeProjectId) : this.browserDrafts.find((draft) => draft.id === id)?.content || null;
  }

  beginEditorDraft() {
    this.activeProjectId = '';
    this.activeDraftId = '';
    this.editorContent = EMPTY_YAML_TEMPLATE;
  }

  selectEditorDraft(id: string): BrowserDraft | undefined {
    const draft = this.browserDrafts.find((item) => item.id === id);
    if (!draft) return undefined;
    this.activeProjectId = '';
    this.activeDraftId = draft.id;
    this.editorContent = draft.content;
    return draft;
  }

  removeEditorDraft(id = this.activeDraftId) {
    if (!id) return;
    this.browserDrafts = this.browserDrafts.filter((draft) => draft.id !== id);
    persistBrowserDrafts(this.browserDrafts);
    if (this.activeDraftId === id) this.activeDraftId = '';
  }

  syncHash() {
    const hash = buildHash(this.currentPage, this.activeProjectId, this.runtimeView);
    if (window.location.hash === hash) return;
    this._syncing = true;
    window.location.hash = hash;
  }

  navigateTo(level: RuntimeLevel, opts: Partial<Pick<RuntimeView, 'agentName' | 'runId' | 'sessionId' | 'sandboxId' | 'loaderId' | 'focusCellId'>> = {}) {
    if (level === 'sandbox-detail') {
      if (this.runtimeView.level !== 'sandbox-detail') this.sandboxReturnView = { ...this.runtimeView };
      this.runtimeView = {
        level,
        agentName: '',
        runId: '',
        sessionId: '',
        sandboxId: opts.sandboxId ?? '',
        loaderId: undefined,
        focusCellId: '',
      };
      this.syncHash();
      return;
    }
    this.sandboxReturnView = null;
    this.runtimeView = {
      level,
      agentName: opts.agentName ?? this.runtimeView.agentName,
      runId: opts.runId ?? this.runtimeView.runId,
      sessionId: opts.sessionId ?? this.runtimeView.sessionId,
      loaderId: opts.loaderId ?? this.runtimeView.loaderId,
      focusCellId: opts.focusCellId ?? this.runtimeView.focusCellId,
      sandboxId: undefined,
    };
    // Clear focusCellId when navigating to a non-session target so it doesn't leak.
    if (level !== 'session') {
      this.runtimeView.focusCellId = opts.focusCellId ?? '';
    }
    this.syncHash();
  }

  navigateBack() {
    const v = this.runtimeView;
    if (v.level === 'agent-detail') {
      this.runtimeView = { level: 'agents', agentName: '', runId: '', sessionId: '' };
    } else if (v.level === 'project-runtime' || v.level === 'latest-run' || v.level === 'schedulers') {
      this.runtimeView = { level: 'agents', agentName: '', runId: '', sessionId: '' };
    } else if (v.level === 'agent-sandboxes') {
      this.runtimeView = { level: 'agent-detail', agentName: v.agentName, runId: '', sessionId: '' };
    } else if (v.level === 'sandbox-detail' && this.sandboxReturnView) {
      this.runtimeView = this.sandboxReturnView;
      this.sandboxReturnView = null;
    } else if (v.level === 'loader-runs') {
      this.runtimeView = { level: 'agents', agentName: '', runId: '', sessionId: '' };
    } else if (v.level === 'loader-run-detail') {
      this.runtimeView = { level: 'loader-runs', agentName: '', runId: '', sessionId: '' };
    } else if (v.level === 'run-detail' || v.level === 'scheduler-run-detail') {
      this.runtimeView = { level: 'agent-detail', agentName: v.agentName, runId: '', sessionId: '' };
    } else if (v.level === 'session') {
      if (v.loaderId) {
        this.runtimeView = { level: 'loader-run-detail', agentName: '', loaderId: v.loaderId, runId: v.runId, sessionId: '' };
      } else if (v.runId) {
        this.runtimeView = { level: 'run-detail', agentName: v.agentName, runId: v.runId, sessionId: '' };
      } else {
        this.runtimeView = { level: 'agent-detail', agentName: v.agentName, runId: '', sessionId: '' };
      }
    }
    this.syncHash();
  }

  goTo(page: Page) {
    this.currentPage = page;
    this.syncHash();
  }

  addToast(message: string, level: 'info' | 'error' | 'success' = 'info') {
    const id = ++this.toastId;
    this.toasts.push({ id, message, level });
    setTimeout(() => {
      const idx = this.toasts.findIndex(t => t.id === id);
      if (idx >= 0) this.toasts.splice(idx, 1);
    }, 5000);
  }

  triggerRuntimeRefresh() {
    this.runtimeRefreshVersion++;
  }
}

export const store = new Store();
