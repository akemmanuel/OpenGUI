import { getDesktopShellClient } from "@/runtime/clients";

/** Copy text, with a textarea fallback for older WebViews. */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

/** Open a URL through the active desktop or web navigation client. */
export function openExternalLink(url: string): void {
  void getDesktopShellClient().navigation.openExternal(url);
}
