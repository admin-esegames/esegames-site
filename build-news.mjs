import fs from "node:fs";
import path from "node:path";

// -------- Config from env --------
const SPACE = process.env.CONTENTFUL_SPACE_ID;
const TOKEN = process.env.CONTENTFUL_CDA_TOKEN;
const ENV = "master";
if (!SPACE || !TOKEN) throw new Error("Set CONTENTFUL_SPACE_ID and CONTENTFUL_CDA_TOKEN");

// -------- Helpers --------
const slugify = (s="") =>
  (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const esc = (s="") =>
  s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

const base = `https://cdn.contentful.com/spaces/${SPACE}/environments/${ENV}`;

// -------- Fetch --------
const res = await fetch(
  `${base}/entries?content_type=newsBlog&order=-fields.date&include=2&limit=1000`,
  { headers: { Authorization: `Bearer ${TOKEN}` } }
);
if (!res.ok) throw new Error(`Contentful error ${res.status}`);
const data = await res.json();

const assetMap = new Map(
  (data.includes?.Asset || []).map(a => [
    a.sys.id,
    {
      url: `https:${a.fields.file?.url || ""}`,
      title: a.fields.title || "",
      desc: a.fields.description || ""
    }
  ])
);

// -------- Rich Text renderer (marks, headings, lists, links, images) --------
function renderRich(rt) {
  if (!rt?.content) return "";

  const renderNodes = nodes => (nodes || []).map(renderNode).join("");
  function renderNode(node) {
    const t = node.nodeType;

    if (t === "text") {
      let out = esc(node.value || "");
      const marks = node.marks || [];
      for (const m of marks) {
        if (m.type === "bold") out = `<strong>${out}</strong>`;
        else if (m.type === "italic") out = `<em>${out}</em>`;
        else if (m.type === "underline") out = `<u>${out}</u>`;
        else if (m.type === "code") out = `<code>${out}</code>`;
      }
      return out;
    }

    if (t === "paragraph") return `<p>${renderNodes(node.content)}</p>`;
    if (t?.startsWith("heading-")) {
      const level = t.split("-")[1];
      return `<h${level}>${renderNodes(node.content)}</h${level}>`;
    }
    if (t === "unordered-list") return `<ul>${renderNodes(node.content)}</ul>`;
    if (t === "ordered-list") return `<ol>${renderNodes(node.content)}</ol>`;
    if (t === "list-item") return `<li>${renderNodes(node.content)}</li>`;
    if (t === "blockquote") return `<blockquote>${renderNodes(node.content)}</blockquote>`;
    if (t === "hr") return `<hr/>`;
    if (t === "hyperlink") {
      const href = node.data?.uri ? esc(node.data.uri) : "#";
      return `<a href="${href}" target="_blank" rel="noopener">${renderNodes(node.content)}</a>`;
    }
    if (t === "embedded-asset-block" || t === "embedded-asset-inline") {
      const id = node.data?.target?.sys?.id;
      const asset = id ? assetMap.get(id) : null;
      if (!asset?.url) return "";
      const alt = esc(asset.title || asset.desc || "");
      return `<figure><img src="${asset.url}" alt="${alt}" class="news-image"/></figure>`;
    }

    // Fallback: render children
    return renderNodes(node.content);
  }

  return renderNodes(rt.content);
}

// plain text snippet for meta description
function richToPlain(rt, max = 155) {
  let buf = "";
  (function walk(n){
    if (!n || buf.length >= max) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.nodeType === "text") buf += n.value || "";
    if (n.content) walk(n.content);
  })(rt);
  return esc(buf.trim().slice(0, max));
}

// -------- Prepare header/footer from NEWS.html to reuse on article pages --------
const newsTpl = fs.readFileSync("NEWS.html", "utf8");
const headerMatch = newsTpl.match(/(<header[\s\S]*?<\/header>)/i);
const footerMatch = newsTpl.match(/(<footer[\s\S]*?<\/footer>)/i);
const headerHTML = headerMatch ? headerMatch[1] : "";
const footerHTML = footerMatch ? footerMatch[1] : "";

// -------- Build list cards and inject into NEWS.html --------
const cards = data.items.map(it => {
  const f = it.fields || {};
  const imgObj = f.image ? assetMap.get(f.image.sys.id) : null;
  const img = imgObj?.url || "";
  const d = f.date ? new Date(f.date).toISOString().slice(0, 10) : "";
  const slug = f.slug ? slugify(f.slug) : slugify(f.title || it.sys.id);

  return `
<article class="news-item">
  <a href="/news/${slug}/"><h2 class="news-title">${esc(f.title || "Untitled")}</h2></a>
  <p class="news-date">${d}</p>
  ${img ? `<img src="${img}" alt="${esc(f.title || "")}" class="news-image">` : ""}
  <details class="news-body">
    <summary>Read more</summary>
    ${renderRich(f.body)}
  </details>
  ${f.link ? `<a class="news-link" href="${esc(f.link)}" target="_blank" rel="noopener">External source</a>` : ""}
</article>`.trim();
}).join("\n");

let newsPage = newsTpl.replace(
  /(<!-- START:NEWS-LIST -->)([\s\S]*?)(<!-- END:NEWS-LIST -->)/,
  `$1\n${cards}\n$3`
);
fs.writeFileSync("NEWS.html", newsPage);

// -------- Build per-article pages --------
for (const it of data.items) {
  const f = it.fields || {};
  const imgObj = f.image ? assetMap.get(f.image.sys.id) : null;
  const img = imgObj?.url || "";
  const iso = f.date ? new Date(f.date).toISOString() : "";
  const dateShort = iso ? iso.slice(0, 10) : "";
  const slug = f.slug ? slugify(f.slug) : slugify(f.title || it.sys.id);
  const dir = path.join("news", slug);
  fs.mkdirSync(dir, { recursive: true });

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": f.title || "Untitled",
    "datePublished": iso || undefined,
    "dateModified": iso || undefined,
    "image": img ? [img] : [],
    "author": { "@type": "Organization", "name": "ĚSĚGAMES" },
    "publisher": { "@type": "Organization", "name": "ĚSĚGAMES" }
  };

  const metaDesc = richToPlain(f.body);

  const head = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<title>${esc(f.title || "News")} — ĚSĚGAMES</title>
<link rel="canonical" href="https://esegames.com/news/${slug}/">
<meta name="description" content="${metaDesc}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/nicepage.css">
<link rel="stylesheet" href="/index.css">
<link rel="stylesheet" href="/FAQstyles.css">
<link rel="stylesheet" href="/news.css">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head><body>`;

const body = `
${headerHTML || ""}
<main class="article">
  <h1>${esc(f.title || "Untitled")}</h1>
  <p class="news-date">${dateShort}</p>
  ${img ? `<img class="news-image" src="${img}" alt="${esc(f.title || "")}">` : ""}
  <article class="news-body">${renderRich(f.body)}</article>
  ${f.link ? `<p><a class="news-link" href="${esc(f.link)}" target="_blank" rel="noopener">Source</a></p>` : ""}
</main>
${footerHTML || ""}
<script src="/FAQscript.js"></script>
</body></html>`;


  fs.writeFileSync(path.join(dir, "index.html"), head + body);
}

// -------- sitemap.xml --------
const urls = [
  "https://esegames.com/NEWS.html",
  ...data.items.map(it => {
    const f = it.fields || {};
    const slug = f.slug ? slugify(f.slug) : slugify(f.title || it.sys.id);
    return `https://esegames.com/news/${slug}/`;
  })
];
const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `<url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>`;
fs.writeFileSync("sitemap.xml", sitemap);

console.log("News built:", data.items.length);
