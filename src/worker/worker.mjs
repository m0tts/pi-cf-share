// Shipped Worker template. The extension copies this file verbatim; it only stages assets
// and a Wrangler config. Keep the lock before every asset lookup, including Markdown.
const STYLE = `:root{color-scheme:light dark}body{font:17px/1.65 system-ui,sans-serif;max-width:780px;margin:3rem auto;padding:0 1.5rem;color:light-dark(#202837,#e5eaf2);background:light-dark(#fff,#151a23)}h1,h2,h3{line-height:1.2}a{color:light-dark(#175cd3,#9cbcff)}pre{overflow:auto;padding:1rem;border-radius:8px;background:light-dark(#f1f4f9,#283244)}code{font:0.9em ui-monospace,monospace}blockquote{border-left:3px solid #889;padding-left:1rem}img{max-width:100%}`;
const escape = (text) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function inline(text) {
  // Escape HTML first. Only allow http(s), relative, or fragment links; never inline HTML.
  return escape(text).replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (whole, label, href) => {
    const url = href.replaceAll("&amp;", "&");
    if (!/^(https?:\/\/|\/|\.\/|\.\.\/|#)/i.test(url)) return whole;
    return `<a href="${escape(url)}" rel="noopener noreferrer">${label}</a>`;
  }).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = false;
  let fence = null;
  let code = [];
  const flush = () => { if (paragraph.length) output.push(`<p>${inline(paragraph.join(" "))}</p>`); paragraph = []; };
  const closeList = () => { if (list) output.push("</ul>"); list = false; };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush(); closeList();
      if (fence !== null) { output.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`); fence = null; code = []; }
      else fence = line;
      continue;
    }
    if (fence !== null) { code.push(line); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const item = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (heading) { flush(); closeList(); output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
    else if (item) { flush(); if (!list) { output.push("<ul>"); list = true; } output.push(`<li>${inline(item[1])}</li>`); }
    else if (!line.trim()) { flush(); closeList(); }
    else { closeList(); paragraph.push(line.trim()); }
  }
  flush(); closeList();
  if (fence !== null) output.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
  return output.join("\n");
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (env.SHARE_LOCKED !== "false") return new Response("Share locked until Access is configured", { status: 403 });
    const url = new URL(request.url);
    const isMarkdown = url.pathname.toLowerCase().endsWith(".md") || (url.pathname === "/" && env.SHARE_INDEX_MD === "true");
    if (!isMarkdown) return env.ASSETS.fetch(request);
    if (url.pathname === "/") url.pathname = "/index.md";
    const asset = await env.ASSETS.fetch(new Request(url, request));
    if (!asset.ok) return asset;
    const source = await asset.text();
    if (url.searchParams.has("raw")) {
      return new Response(request.method === "HEAD" ? null : source, { headers: { "Content-Type": "text/markdown; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
    }
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared Markdown</title><style>${STYLE}</style><main>${renderMarkdown(source)}</main></html>`;
    return new Response(request.method === "HEAD" ? null : html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'", "X-Content-Type-Options": "nosniff" } });
  },
};
