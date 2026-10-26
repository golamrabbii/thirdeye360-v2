// Copy text to the clipboard in any serving context.
//
// navigator.clipboard only exists in secure contexts (HTTPS or http://localhost).
// When the app is served over plain HTTP on a LAN IP (e.g. http://192.168.x.x:3000)
// it is undefined, so fall back to the legacy execCommand approach.

export async function copyToClipboard(text) {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    window.isSecureContext
  ) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  // Fallback for insecure contexts (e.g. http://<lan-ip>:3000)
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    const ok = document.execCommand("copy");
    if (!ok) {
      throw new Error("execCommand copy returned false");
    }
    return true;
  } finally {
    document.body.removeChild(textarea);
  }
}
