<script lang="ts">
  let { agentName, runId, embedded = false }: { agentName: string; runId: string; embedded?: boolean } = $props();
</script>

<div data-testid="run-evidence" data-embedded={embedded}>{agentName}:{runId}</div>
