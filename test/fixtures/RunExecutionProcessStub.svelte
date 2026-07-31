<script lang="ts">
  import { RunDetail, RunStatus, RunSummary } from '../../src/gen/agentcompose/v2/agentcompose_pb';
  let { projectId, agentName, runId, onDetail = () => {}, onSettled = () => {} }: {
    projectId: string; agentName: string; runId: string;
    onDetail?: (detail: RunDetail | null) => void;
    onSettled?: (status: RunStatus, completedAt: string) => void;
  } = $props();
</script>

<div data-testid="execution-process" data-project-id={projectId}>{agentName}:{runId}</div>
<button data-testid="emit-running-{agentName}" onclick={() => onDetail(new RunDetail({ summary: new RunSummary({ runId, agentName, status: RunStatus.RUNNING }) }))}>emit running</button>
<button data-testid="emit-succeeded-{agentName}" onclick={() => onSettled(RunStatus.SUCCEEDED, 'done')}>emit succeeded</button>
