export const ARTIFACT_WIDGET_URI = "ui://codex-bridge/artifact-viewer-v1.html";

export const ARTIFACT_WIDGET_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 12px; background: transparent; color: CanvasText; }
    header { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .identity { min-width: 0; }
    #name { font-weight: 650; overflow-wrap: anywhere; }
    #details { font-size: 12px; opacity: .72; margin-top: 2px; }
    #download { border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 8px; padding: 7px 11px; color: inherit; text-decoration: none; white-space: nowrap; }
    #stage { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 10px; overflow: hidden; min-height: 80px; }
    img, video, embed { display: block; width: 100%; max-height: 70vh; object-fit: contain; border: 0; }
    embed { height: 68vh; }
    audio { width: calc(100% - 24px); margin: 12px; }
    pre { margin: 0; padding: 12px; max-height: 68vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .message { padding: 22px; text-align: center; opacity: .76; }
  </style>
</head>
<body>
  <header>
    <div class="identity"><div id="name">Waiting for file…</div><div id="details"></div></div>
    <a id="download" hidden>Download</a>
  </header>
  <main id="stage"><div class="message">The file will appear when the tool result arrives.</div></main>
  <script>
    const nameEl = document.getElementById("name");
    const detailsEl = document.getElementById("details");
    const stageEl = document.getElementById("stage");
    const downloadEl = document.getElementById("download");
    let objectUrl;

    function bytesFromBase64(value) {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }

    function humanBytes(value) {
      if (!Number.isFinite(value)) return "";
      const units = ["B", "KB", "MB", "GB"];
      let amount = value;
      let unit = 0;
      while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
      return (unit === 0 ? amount : amount.toFixed(amount >= 10 ? 1 : 2)) + " " + units[unit];
    }

    function show(result) {
      const metadata = result?.structuredContent?.artifact;
      if (!metadata) return;
      const blocks = Array.isArray(result.content) ? result.content : [];
      const payload = blocks.find((block) => block?.type === "resource")?.resource
        || blocks.find((block) => block?.type === "image")
        || blocks.find((block) => block?.type === "audio");
      nameEl.textContent = metadata.name || metadata.path || "File";
      detailsEl.textContent = [metadata.mime_type, humanBytes(metadata.size), metadata.path].filter(Boolean).join(" · ");
      stageEl.replaceChildren();
      if (!payload) {
        stageEl.innerHTML = '<div class="message">This host did not forward the file payload. Use the resource link in the tool result.</div>';
        return;
      }
      const mime = payload.mimeType || metadata.mime_type || "application/octet-stream";
      let data;
      if (typeof payload.blob === "string") data = bytesFromBase64(payload.blob);
      else if (typeof payload.data === "string") data = bytesFromBase64(payload.data);
      else if (typeof payload.text === "string") data = new TextEncoder().encode(payload.text);
      if (!data) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
      downloadEl.href = objectUrl;
      downloadEl.download = metadata.name || "download";
      downloadEl.hidden = false;

      let view;
      if (mime.startsWith("image/")) {
        view = document.createElement("img"); view.src = objectUrl; view.alt = metadata.name || "image";
      } else if (mime.startsWith("audio/")) {
        view = document.createElement("audio"); view.src = objectUrl; view.controls = true;
      } else if (mime.startsWith("video/")) {
        view = document.createElement("video"); view.src = objectUrl; view.controls = true;
      } else if (mime === "application/pdf") {
        view = document.createElement("embed"); view.src = objectUrl; view.type = mime;
      } else if (typeof payload.text === "string") {
        view = document.createElement("pre"); view.textContent = payload.text;
      } else {
        view = document.createElement("div"); view.className = "message"; view.textContent = "Preview is not available for this file type. You can download the original file.";
      }
      stageEl.appendChild(view);
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method === "ui/notifications/tool-result") show(message.params);
    }, { passive: true });

    const compatibility = window.openai?.toolResponseMetadata?.mcp_tool_result;
    if (compatibility) show(compatibility);
  </script>
</body>
</html>`;
