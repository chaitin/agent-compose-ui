<script lang="ts">
  import type { AbstractNode, IconDefinition } from '@ant-design/icons-svg/es/types';

  type Props = {
    definition: IconDefinition;
    class?: string;
  };

  const { definition, class: className = '' }: Props = $props();

  function resolveIcon(definition: IconDefinition): AbstractNode {
    return typeof definition.icon === 'function' ? definition.icon('currentColor', 'currentColor') : definition.icon;
  }

  function collectPaths(node: AbstractNode): Array<AbstractNode['attrs']> {
    const children = node.children ?? [];
    const childPaths = children.flatMap((child) => collectPaths(child));
    return node.tag === 'path' ? [node.attrs, ...childPaths] : childPaths;
  }

  const icon = $derived(resolveIcon(definition));
  const paths = $derived(collectPaths(icon));
</script>

<svg
  class={className}
  aria-hidden="true"
  viewBox={icon.attrs.viewBox}
  focusable={icon.attrs.focusable ?? 'false'}
>
  {#each paths as path}
    <path {...path}></path>
  {/each}
</svg>
