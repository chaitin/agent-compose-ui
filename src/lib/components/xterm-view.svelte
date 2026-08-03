<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Terminal } from 'xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import 'xterm/css/xterm.css';

  let {
    lines = [],
    rows = 18,
    fontSize = 15,
    interactive = false,
    onData,
    onResize,
  }: {
    lines?: string[];
    rows?: number;
    fontSize?: number;
    interactive?: boolean;
    onData?: (data: string) => void;
    onResize?: (cols: number, rows: number) => void;
  } = $props();

  let node: HTMLDivElement;
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let ro: ResizeObserver | null = null;
  let writtenLines = 0;

  function safeFit() {
    try {
      fit?.fit();
    } catch {
      // 容器在 tab 隐藏/路由切换时可能尺寸为 0，xterm.fit 会抛错，忽略即可
    }
  }

  onMount(() => {
    term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      disableStdin: !interactive,
      rows,
      scrollback: 2000,
      fontFamily: 'IBM Plex Mono, Fira Code, ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize,
      lineHeight: 1.25,
      theme: {
        background: '#121722',
        foreground: '#cdd6e3',
        cursor: '#e0b25a',
        selectionBackground: 'rgba(224, 178, 90, 0.25)',
      },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    safeFit();
    for (const line of lines) term.write(line);
    writtenLines = lines.length;
    if (interactive && onData) term.onData(onData);
    if (onResize) term.onResize(({ cols, rows: terminalRows }) => onResize(cols, terminalRows));
    // tab 由隐藏变可见（尺寸 0 → 实际）时自动重排
    ro = new ResizeObserver(() => safeFit());
    ro.observe(node);
  });

  $effect(() => {
    if (!term || lines.length <= writtenLines) return;
    for (const line of lines.slice(writtenLines)) term.write(line);
    writtenLines = lines.length;
  });

  $effect(() => {
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    safeFit();
  });

  onDestroy(() => {
    ro?.disconnect();
    term?.dispose();
  });
</script>

<div bind:this={node} data-scroll-surface class="h-full w-full"></div>
