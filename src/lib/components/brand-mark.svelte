<script lang="ts">
  let { class: className = '' }: { class?: string } = $props();
</script>

<svg class={className} viewBox="0 0 168 120" role="img" aria-label="Agent Compose" xmlns="http://www.w3.org/2000/svg">
  <rect width="168" height="120" rx="12" fill="#050907" />
  <g transform="translate(23 26)">
    <path d="M5 14h22c9 0 10 14 20 14h12" fill="none" stroke="#45e184" stroke-width="7" stroke-linecap="round" />
    <path d="M5 34h54" fill="none" stroke="#b8c4bc" stroke-opacity=".86" stroke-width="7" stroke-linecap="round" />
    <path d="M5 54h22c9 0 10-14 20-14h12" fill="none" stroke="#45e184" stroke-width="7" stroke-linecap="round" />
    <circle cx="5" cy="14" r="5" fill="#e9f1ec" />
    <circle cx="5" cy="34" r="5" fill="#e9f1ec" />
    <circle cx="5" cy="54" r="5" fill="#e9f1ec" />
    <circle cx="58" cy="34" r="6" fill="#45e184" stroke="#e9f1ec" stroke-width="3" />
    <rect
      x="70"
      y="2"
      width="58"
      height="64"
      rx="17"
      fill="#0b0d0c"
      stroke="#e9f1ec"
      stroke-opacity=".8"
      stroke-width="3"
    />
    <path
      d="M90 23l13 12-13 12"
      fill="none"
      stroke="#e9f1ec"
      stroke-width="8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path d="M111 54h9" fill="none" stroke="#45e184" stroke-width="8" stroke-linecap="round" />
  </g>
</svg>
