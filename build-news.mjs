import fs from "node:fs";
import path from "node:path";

// --- Debug: confirm env vars are visible to Vercel build ---
console.log("SPACE set?", Boolean(process.env.CONTENTFUL_SPACE_ID));
console.log("TOKEN set?", Boolean(process.env.CONTENTFUL_CDA_TOKEN));
console.log("OPTIONAL CONTENTFUL_ENV =", process.env.CONTENTFUL_ENV || "(not set)");

// -------- Config from env --------
const SPACE = process.env.CONTENTFUL_SPACE_ID;
const TOKEN = process.env.CONTENTFUL_CDA_TOKEN;
if (!SPACE || !TOKEN) throw new Error("Set CONTENTFUL_SPACE_ID and CONTENTFUL_CDA_TOKEN");

// -------- Helpers --------
const slugify = (s = "") =>
  (s || "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const esc = (s = "") =>
  (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

// -------- Fetch (try envs) --------
const ENV_FROM_VAR = process.env.CONTENTFUL_ENV || "master";
const envCandidates = Array.from(new Set([ENV_FROM_VAR, "master", "main"]));

let data = null;
let ENV_USED = null;
for (const envId of envCandidates) {
  const base = `https://cdn.contentful.com/spaces/${SPACE}/environments/${envId}`;
  const url  = `${base}/entries?content_type=newsBlog&order=-fields.date&include=2&limit=1000`;
  console.log("Trying Contentful env:", envId, "→", url);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  console.log("HTTP", res.status, "for env", envId);
  if (res.ok) { data = await res.json(); ENV_USED = envId; break; }
  if (res.status === 401 || res.status === 403) {
    throw new Error("Auth error from Contentful. Use a Content Delivery API token with access to this environment.");
  }
}
if (!data) throw new Error(`Could not fetch entries. Checked envs: ${envCandidates.join(", ")}. Verify your environment ID and content type "newsBlog".`);
console.log("Using Contentful env:", ENV_USED);
console.log("items returned:", data.items?.length || 0);

// -------- Build asset map (keep width/height if available) --------
const assetMap = new Map(
  (data.includes?.Asset || []).map(a => {
    const file = a.fields.file || {};
    const details = file.details || {};
    const imgDims = details.image || {};
    return [a.sys.id, {
      url: `https:${file.url || ""}`,
      title: a.fields.title || "",
      desc: a.fields.description || "",
      width: imgDims.width || null,
      height: imgDims.height || null
    }];
  })
);

// -------- Img helper (adds lazy/eager, fetchpriority, preserves w/h) --------
function renderNewsImage(img, i = 1) {
  if (!img?.src) return "";
  const attrs = [
    `src="${img.src}"`,
    `alt="${esc(img.alt || "")}"`,
    `class="news-image"`,
    `loading="${i === 0 ? "eager" : "lazy"}"`,
    `decoding="async"`,
    `fetchpriority="${i === 0 ? "high" : "low"}"`
  ];
  if (img.width && img.height) {
    attrs.push(`width="${img.width}"`, `height="${img.height}"`);
  }
  return `<img ${attrs.join(" ")}>`;
}

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
    if (t === "ordered-list")   return `<ol>${renderNodes(node.content)}</ol>`;
    if (t === "list-item")      return `<li>${renderNodes(node.content)}</li>`;
    if (t === "blockquote")     return `<blockquote>${renderNodes(node.content)}</blockquote>`;
    if (t === "hr")             return `<hr/>`;
    if (t === "hyperlink") {
      const href = node.data?.uri ? esc(node.data.uri) : "#";
      return `<a href="${href}" target="_blank" rel="noopener">${renderNodes(node.content)}</a>`;
    }
    if (t === "embedded-asset-block" || t === "embedded-asset-inline") {
      const id = node.data?.target?.sys?.id;
      const asset = id ? assetMap.get(id) : null;
      if (!asset?.url) return "";
      const alt = esc(asset.title || asset.desc || "");
      const wh = (asset.width && asset.height) ? ` width="${asset.width}" height="${asset.height}"` : "";
      return `<figure><img src="${asset.url}" alt="${alt}" class="news-image" loading="lazy" decoding="async"${wh}></figure>`;
    }

    return renderNodes(node.content);
  }
  return renderNodes(rt.content);
}

// -------- Split RT into lead (first paragraph) + rest --------
function splitLead(rt, take = 1) {
  const outLead = [], outRest = [];
  let taken = 0;
  for (const node of rt?.content || []) {
    if (taken < take && node.nodeType === "paragraph") { outLead.push(node); taken++; continue; }
    outRest.push(node);
  }
  return {
    lead: { nodeType: "document", content: outLead },
    rest: { nodeType: "document", content: outRest }
  };
}

// -------- plain text snippet for meta description --------
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
console.log("Header found?", Boolean(headerHTML), "Footer found?", Boolean(footerHTML));

// -------- Build list cards and inject into NEWS.html --------
const cards = (data.items || []).map((it, i) => {
  const f = it.fields || {};
  const imgObj = f.image ? assetMap.get(f.image.sys.id) : null;
  const imgMeta = imgObj ? {
    src: imgObj.url,
    alt: f.title || imgObj.title,
    width: imgObj.width,
    height: imgObj.height
  } : null;
  const d = f.date ? new Date(f.date).toISOString().slice(0, 10) : "";
  const slug = f.slug ? slugify(f.slug) : slugify(f.title || it.sys.id);
  const { lead, rest } = splitLead(f.body, 1);
  const leadHTML = renderRich(lead);
  const restHTML = renderRich(rest);
  const hasMore = rest?.content?.length > 0;

  return `
<article class="news-item">
  <a href="/news/${slug}/"><h2 class="news-title">${esc(f.title || "Untitled")}</h2></a>
  <p class="news-date">${d}</p>
  ${imgMeta ? renderNewsImage(imgMeta, i) : ""}
  ${leadHTML ? `<div class="news-excerpt">${leadHTML}</div>` : ""}
  ${hasMore ? `
  <details class="news-collapsible">
    <summary class="news-summary">Read more</summary>
    <div class="news-body">${restHTML}</div>
  </details>` : ""}
  ${f.link ? `<p class="news-source"><a href="${esc(f.link)}" target="_blank" rel="noopener">External source</a></p>` : ""}
</article>`.trim();
}).join("\n");

let newsPage = newsTpl.replace(
  /(<!-- START:NEWS-LIST -->)([\s\S]*?)(<!-- END:NEWS-LIST -->)/,
  `$1\n${cards}\n$3`
);

// ensure RSS <link> exists in NEWS head
if (!/rel="alternate"\s+type="application\/rss\+xml"/i.test(newsPage)) {
  newsPage = newsPage.replace(/<\/head>/i,
    `  <link rel="alternate" type="application/rss+xml" title="ÉSÈGAMES News" href="/news.xml">\n</head>`);
}

fs.writeFileSync("NEWS.html", newsPage);
console.log("Injected", (data.items || []).length, "cards into NEWS.html");

// -------- Build per-article pages --------
for (const it of data.items || []) {
  const f = it.fields || {};
  const imgObj = f.image ? assetMap.get(f.image.sys.id) : null;
  const hero = imgObj ? { src: imgObj.url, alt: f.title || imgObj.title, width: imgObj.width, height: imgObj.height } : null;
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
    "image": hero?.src ? [hero.src] : [],
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
<link rel="alternate" type="application/rss+xml" title="ÉSÈGAMES News" href="/news.xml">
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
  ${hero ? renderNewsImage(hero, 0) : ""}
  <article class="news-body">${renderRich(f.body)}</article>
  ${f.link ? `<p><a class="news-link" href="${esc(f.link)}" target="_blank" rel="noopener">Source</a></p>` : ""}
</main>
${footerHTML || ""}
<script src="/FAQscript.js"></script>
</body></html>`;

  fs.writeFileSync(path.join(dir, "index.html"), head + body);
  console.log("Wrote article page:", `/news/${slug}/index.html`);
}

// -------- sitemap.xml --------
const urls = [
  "https://esegames.com/NEWS",
  ...(data.items || []).map(it => {
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
console.log("Wrote sitemap.xml with", urls.length, "URLs");

// -------- news.xml (RSS 2.0) --------
const SITE = "https://esegames.com";
const rssItems = (data.items || []).map(it => {
  const f = it.fields || {};
  const slug = f.slug ? slugify(f.slug) : slugify(f.title || it.sys.id);
  const url = `${SITE}/news/${slug}/`;
  const title = esc(f.title || "Untitled");
  const pub = f.date ? new Date(f.date).toUTCString() : new Date().toUTCString();
  const desc = richToPlain(f.body, 300);
  return `
  <item>
    <title>${title}</title>
    <link>${url}</link>
    <guid isPermaLink="false">${it.sys.id}</guid>
    <pubDate>${pub}</pubDate>
    <description><![CDATA[${desc}]]></description>
  </item>`.trim();
}).join("\n");

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>ÉSÈGAMES News</title>
    <link>${SITE}/NEWS</link>
    <description>Updates from ÉSÈGAMES</description>
    <language>en</language>
    <atom:link href="${SITE}/news.xml" rel="self" type="application/rss+xml"/>
${rssItems}
  </channel>
</rss>`;
fs.writeFileSync("news.xml", rss);
console.log("Wrote news.xml");

console.log("News built complete. Items:", data.items?.length || 0);
