// Shared escaping and page shell for artifact templates rendered through show_html.
// Templates are self-contained HTML: no network, no storage, no form posts.
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replaceAll("\n", "&#10;");
}

/** JSON embedded in a <script>: `<` never closes the script element. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)?.replaceAll("<", "\\u003c") ?? "null";
}

/** A full show_html document on the host theme variables the helper injects. */
export function artifactShell(args: { title: string; css: string; body: string; script?: string }): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(args.title)}</title><style>
body{margin:0;padding:0;font-family:var(--font-sans);color:var(--color-text-primary);background:var(--color-background-primary)}
${args.css}</style></head><body>${args.body}${args.script ? `<script>${args.script}</script>` : ""}</body></html>`;
}
