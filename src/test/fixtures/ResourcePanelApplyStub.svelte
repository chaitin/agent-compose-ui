<script lang="ts">
  interface Props { onApply: () => Promise<void> }
  let { onApply }: Props = $props();
  let state = $state('idle');
  async function apply() { state = 'pending'; try { await onApply(); state = 'done'; } catch { state = 'failed'; } }
</script>
<button type="button" onclick={apply}>Mounts Apply</button><span role="status">{state}</span>
