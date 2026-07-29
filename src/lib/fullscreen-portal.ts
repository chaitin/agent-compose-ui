export function fullscreenPortal(node: HTMLElement, enabled: boolean) {
  const parent = node.parentNode;
  const nextSibling = node.nextSibling;
  let active = false;

  function restore(): void {
    if (!active || !parent) return;
    if (nextSibling?.parentNode === parent) {
      parent.insertBefore(node, nextSibling);
    } else {
      parent.appendChild(node);
    }
    active = false;
  }

  function update(nextEnabled: boolean): void {
    if (nextEnabled === active) return;
    if (nextEnabled) {
      document.body.append(node);
      active = true;
    } else {
      restore();
    }
  }

  update(enabled);
  return {
    update,
    destroy: restore,
  };
}
