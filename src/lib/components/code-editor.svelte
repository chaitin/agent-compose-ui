<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { loadMonaco } from '$lib/monaco';
  import Expand from '@lucide/svelte/icons/expand';
  import Minimize2 from '@lucide/svelte/icons/minimize-2';
  import WandSparkles from '@lucide/svelte/icons/wand-sparkles';

  let {
    value = $bindable(''),
    language = 'javascript',
    readOnly = false,
    height = '36rem',
    title = '代码编辑器',
    formatEnabled = true,
  }: {
    value?: string;
    language?: string;
    readOnly?: boolean;
    height?: string;
    title?: string;
    formatEnabled?: boolean;
  } = $props();

  let container: HTMLDivElement;
  let editor: import('monaco-editor').editor.IStandaloneCodeEditor | undefined;
  let fullscreen = $state(false);
  let formatting = $state(false);
  let formatError = $state('');
  let loading = $state(true);
  let loadError = $state('');

  async function formatDocument(): Promise<void> {
    if (!editor || readOnly || !formatEnabled) return;
    formatting = true;
    formatError = '';
    try {
      if (language === 'javascript' || language === 'typescript' || language === 'json') {
        const [prettier, babel, estree] = await Promise.all([
          import('prettier/standalone'),
          import('prettier/plugins/babel'),
          import('prettier/plugins/estree'),
        ]);
        const formatted = await prettier.format(editor.getValue(), {
          parser: language === 'json' ? 'json' : language === 'typescript' ? 'babel-ts' : 'babel',
          plugins: [babel.default, estree.default],
          printWidth: 100,
          singleQuote: true,
          // The daemon scheduler embeds QuickJS, whose parser rejects trailing
          // commas in some call expressions accepted by modern browsers.
          trailingComma: 'none',
        });
        editor.setValue(formatted);
      } else {
        await editor.getAction('editor.action.formatDocument')?.run();
      }
    } catch (cause) {
      formatError = cause instanceof Error ? cause.message : '格式化失败';
    } finally {
      formatting = false;
      editor.focus();
    }
  }

  function toggleFullscreen(): void {
    fullscreen = !fullscreen;
    requestAnimationFrame(() => editor?.layout());
  }

  $effect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  });

  onMount(() => {
    let disposed = false;
    let observer: MutationObserver | undefined;

    void loadMonaco()
      .then((monaco) => {
        if (disposed) return;
        const createdEditor = monaco.editor.create(container, {
          value,
          language,
          readOnly,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          folding: true,
          bracketPairColorization: { enabled: true },
          stickyScroll: { enabled: true },
          lineNumbersMinChars: 3,
          padding: { top: 10, bottom: 10 },
          scrollBeyondLastLine: false,
          theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
        });
        editor = createdEditor;
        createdEditor.onDidChangeModelContent(() => {
          value = createdEditor.getValue();
        });
        createdEditor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
          void formatDocument();
        });
        observer = new MutationObserver(() => {
          monaco.editor.setTheme(document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs');
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        loading = false;
      })
      .catch((cause) => {
        loading = false;
        loadError = cause instanceof Error ? cause.message : '编辑器加载失败';
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      editor?.dispose();
    };
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (fullscreen && event.key === 'Escape') toggleFullscreen();
  }}
/>

<div
  data-scroll-surface
  class:fixed={fullscreen}
  class:inset-3={fullscreen}
  class:z-50={fullscreen}
  class="flex min-h-[16rem] flex-col overflow-hidden rounded-lg border border-input bg-background shadow-sm"
  style:height={fullscreen ? 'calc(100vh - 1.5rem)' : height}
  style:resize={fullscreen ? 'none' : 'vertical'}
>
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-2">
    <span class="text-xs font-medium">{title}</span>
    <span class="text-[11px] text-muted-foreground">{language} · Shift+Alt+F 格式化</span>
    {#if formatError}<span class="min-w-0 truncate text-xs text-destructive" title={formatError}>{formatError}</span
      >{/if}
    <div class="ml-auto flex gap-1">
      {#if formatEnabled && !readOnly}<Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={formatting}
          onclick={formatDocument}><WandSparkles class="size-3.5" />{formatting ? '格式化中…' : '格式化'}</Button
        >{/if}<Button type="button" variant="ghost" size="sm" onclick={toggleFullscreen}
        >{#if fullscreen}<Minimize2 class="size-3.5" />退出全屏{:else}<Expand class="size-3.5" />全屏{/if}</Button
      >
    </div>
  </div>
  <div class="relative min-h-0 flex-1">
    <div bind:this={container} class="absolute inset-0"></div>
    {#if loading}<div
        class="absolute inset-0 flex items-center justify-center bg-background text-sm text-muted-foreground"
      >
        正在加载代码编辑器…
      </div>{:else if loadError}<div
        class="absolute inset-0 flex items-center justify-center bg-background p-4 text-sm text-destructive"
      >
        {loadError}
      </div>{/if}
  </div>
</div>
