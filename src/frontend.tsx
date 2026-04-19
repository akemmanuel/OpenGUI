/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";

const elem = document.getElementById("root");
if (!elem) throw new Error("Root element not found");
// StrictMode removed: its double-mount behaviour causes IPC event
// subscriptions (e.g. SSE bridge) to fire twice, producing garbled
// streaming output in the Electron renderer.
const app = <App />;

if (import.meta.hot) {
	// With hot module reloading, `import.meta.hot.data` is persisted.
	if (!import.meta.hot.data.root) {
		import.meta.hot.data.root = createRoot(elem);
	}
	const root = import.meta.hot.data.root;
	root.render(app);
} else {
	// The hot module reloading API is not available in production.
	createRoot(elem).render(app);
}
