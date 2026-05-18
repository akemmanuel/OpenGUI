// Suppress noisy upstream Node.js deprecation warnings during Vite/Vite+ config loading.
// Node 25+/26 emits DEP0205 for dependencies that still call module.register().
// This happens before the app build starts and is not actionable in OpenGUI itself.
process.noDeprecation = true;
