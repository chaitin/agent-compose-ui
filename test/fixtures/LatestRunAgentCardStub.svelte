<script lang="ts">
  import type { YamlRunBatchAgent } from '../../src/lib/yaml-run-batch';
  let { agent }: { agent: YamlRunBatchAgent } = $props();
</script>
<div data-testid="latest-card">{agent.agentName}</div>
