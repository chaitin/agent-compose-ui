<script lang="ts">
  let { compact = false, class: className = '' }: { compact?: boolean; class?: string } = $props();
</script>

<svg
  class={`brand-logo ${className}`}
  viewBox={compact ? '0 0 138 78' : '0 0 470 78'}
  role="img"
  aria-label="Agent-Compose"
>
  <g transform="translate(2 5)">
    <path d="M4 14h22c9 0 10 14 20 14h12" fill="none" stroke="var(--logo-accent)" stroke-width="7" stroke-linecap="round" />
    <path d="M4 34h54" fill="none" stroke="var(--logo-muted)" stroke-opacity=".86" stroke-width="7" stroke-linecap="round" />
    <path d="M4 54h22c9 0 10-14 20-14h12" fill="none" stroke="var(--logo-accent)" stroke-opacity=".72" stroke-width="7" stroke-linecap="round" />
    <circle cx="5" cy="14" r="5" fill="var(--logo-ink)" />
    <circle cx="5" cy="34" r="5" fill="var(--logo-ink)" />
    <circle cx="5" cy="54" r="5" fill="var(--logo-ink)" />
    <circle cx="58" cy="34" r="6" fill="var(--logo-accent)" stroke="var(--logo-ink)" stroke-width="3" />
    <rect x="70" y="2" width="58" height="64" rx="17" fill="var(--logo-surface)" stroke="var(--logo-ink)" stroke-opacity=".8" stroke-width="3" />
    <path d="M90 23l13 12-13 12" fill="none" stroke="var(--logo-ink)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M111 54h9" fill="none" stroke="var(--logo-accent)" stroke-width="8" stroke-linecap="round" />
  </g>
  <text x="154" y="50" fill="var(--logo-ink)" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="38" font-weight="850" letter-spacing="-1.4">Agent</text>
  <path d="M266 38h12" fill="none" stroke="var(--logo-accent)" stroke-width="4" stroke-linecap="round" />
  <text x="286" y="50" fill="var(--logo-accent)" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="38" font-weight="850" letter-spacing="-1.4">Compose</text>
</svg>

<style>
  .brand-logo {
    --logo-ink: var(--foreground);
    --logo-muted: var(--muted-foreground);
    --logo-accent: var(--primary);
    --logo-surface: var(--card);
  }
</style>
