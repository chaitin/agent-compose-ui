<script lang="ts">
  import { toggleMode } from 'mode-watcher';
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import { Button } from '$lib/components/ui/button';
  import { t } from '$lib/i18n.svelte';
</script>

<Button variant="ghost" size="icon" onclick={toggleMode} title={t('切换主题')} aria-label={t('切换主题')}>
  <Sun class="size-4 dark:hidden" />
  <Moon class="hidden size-4 dark:block" />
</Button>
