export interface ProjectSource {
  composePath: string;
  projectDir: string;
}

export interface ProjectEntry {
  summary: {
    projectId: string;
    name: string;
    sourcePath: string;
    currentRevision: bigint;
    specHash: string;
    agentCount: number;
    schedulerCount: number;
    runningRunCount: number;
    latestRunId: string;
    createdAt: string;
    updatedAt: string;
  };
  source: ProjectSource;
  yamlContent: string;
  dirty: boolean;
}

export interface ToastMessage {
  id: number;
  message: string;
  level: 'info' | 'error' | 'success';
}
