export async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Clipboard API can be present but denied on non-secure origins; use the synchronous browser fallback.
  }

  const textarea = document.createElement('textarea');
  textarea.dataset.clipboardFallback = '';
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    if (!document.execCommand?.('copy')) throw new Error('clipboard copy failed');
  } finally {
    textarea.remove();
  }
}
