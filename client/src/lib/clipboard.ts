/**
 * Put `text` on the clipboard, resolving whether it got there. Never throws.
 *
 * `navigator.clipboard` exists only in a secure context, so the plain-HTTP LAN shape has none; there, and when the API rejects (permission, focus), an
 * off-screen `<textarea>` + `document.execCommand('copy')` still works inside the click that called this.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  return execCopy(text);
}

function execCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  try {
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}
