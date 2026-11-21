export function openModelConnections(returnToSetup = false) {
  window.dispatchEvent(
    new CustomEvent("opengui:open-settings", {
      detail: { showModelConnections: true, returnToSetup },
    }),
  );
}
