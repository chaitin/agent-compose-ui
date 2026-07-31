<script lang="ts">
  interface Props { count: number; onConfigure: () => void; }
  let { count, onConfigure }: Props = $props();
</script>

<button onclick={onConfigure} title="将缺失变量保存到系统管理的全局环境变量">
  {count > 1 ? `配置变量值 (${count})` : '配置变量值'}
</button>

<style>
  button{pointer-events:auto;min-width:0;max-width:100%;padding:2px 8px;border:1px solid var(--accent-orange);border-radius:3px;background:color-mix(in srgb,var(--accent-orange) 12%,transparent);color:var(--accent-orange);cursor:pointer;font-size:var(--font-size-xs);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  button:hover{background:color-mix(in srgb,var(--accent-orange) 24%,transparent)}
</style>
