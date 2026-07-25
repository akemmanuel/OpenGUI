# Uploaded prompt files replace prompt image attachments

OpenGUI prompts are text-only: files entering the Project-connected Prompt are uploaded to OpenGUI Backend temp storage and inserted as `@<path>` mentions in the prompt text. We removed the parallel frontend prompt-image attachment channel because temp file mentions work consistently across Desktop, Web, Mobile, local backends, and hosted backends, and they support every file type instead of treating images as special.

When the model calls `read` for an image, the Harness processes and downscales the file and returns a native image content block to the next model turn, following Pi's read-tool behavior. This is an internal multimodal tool result, not a second frontend upload or prompt persistence channel. If an endpoint rejects image input, the model adapter retries without the image, includes an omission note in the tool result, and remembers that model as text-only for later turns.
