import express from "express";
import axios from "axios";
import { Resvg } from "@resvg/resvg-js";

const app = express();
const PORT = process.env.PORT || 3847;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(tag, msg, data = null) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tag}] ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

app.use((req, _res, next) => {
  log("REQUEST", `${req.method} ${req.path}`, { query: req.query, ip: req.headers["x-forwarded-for"] ?? req.socket.remoteAddress });
  next();
});

// ─── Reddit ───────────────────────────────────────────────────────────────────
const redditClient = axios.create({
  baseURL: "https://www.reddit.com",
  headers: { "User-Agent": "Mozilla/5.0 (compatible; HonkBot/1.0)" },
  timeout: 10_000,
});

function normalisePost(post) {
  let imageUrl = null;
  if (post.thumbnail && !["self","default","nsfw",""].includes(post.thumbnail)) imageUrl = post.thumbnail;
  if (post.preview?.images?.[0]?.source?.url) imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, "&");
  return {
    id: post.id,
    title: post.title,
    author: post.author,
    score: post.score,
    upvote_ratio: post.upvote_ratio,
    num_comments: post.num_comments,
    created_at: new Date(post.created_utc * 1000).toISOString(),
    url: `https://reddit.com${post.permalink}`,
    flair: post.link_flair_text ?? null,
    selftext_preview: post.selftext?.slice(0, 150) ?? null,
    image_url: imageUrl,
  };
}

async function searchLevels(query, limit = 15) {
  log("REDDIT", `Searching r/honk for "${query}" limit ${limit}`);
  const start = Date.now();
  try {
    const res = await redditClient.get("/r/honk/search.json", {
      params: { q: query, restrict_sr: 1, sort: "relevance", type: "link", limit: 25, t: "all" },
    });
    const posts = (res.data?.data?.children ?? [])
      .map(c => c.data)
      .filter(p => !p.removed_by_category)
      .slice(0, limit)
      .map(normalisePost);
    log("REDDIT", `Got ${posts.length} results in ${Date.now()-start}ms`);
    return posts;
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err.code === "ECONNABORTED") log("REDDIT_ERROR", `TIMED OUT after ${elapsed}ms`);
    else if (err.response)           log("REDDIT_ERROR", `HTTP ${err.response.status} after ${elapsed}ms`);
    else                             log("REDDIT_ERROR", `FAILED after ${elapsed}ms: ${err.message}`);
    throw err;
  }
}

async function getSinglePost(postId) {
  const id = postId.replace(/^t3_/, "");
  log("REDDIT", `Fetching single post ${id}`);
  const start = Date.now();
  try {
    const res = await redditClient.get(`/r/honk/comments/${id}.json`, { params: { limit: 1 } });
    const post = res.data?.[0]?.data?.children?.[0]?.data;
    if (!post) throw new Error(`Post ${id} not found`);
    log("REDDIT", `Fetched "${post.title}" in ${Date.now()-start}ms`);
    return normalisePost(post);
  } catch (err) {
    log("REDDIT_ERROR", `FAILED after ${Date.now()-start}ms: ${err.message}`);
    throw err;
  }
}

// ─── SVG + PNG ────────────────────────────────────────────────────────────────
function esc(s) { return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function trunc(s,n) { return s?.length>n ? s.slice(0,n-1)+"…":(s??""); }
function fmtNum(n) { return n>=1000?(n/1000).toFixed(1)+"k":String(n); }
function relTime(iso) {
  const d=Date.now()-new Date(iso).getTime(),m=Math.floor(d/60000),h=Math.floor(d/3600000),dy=Math.floor(d/86400000);
  if(m<60)return `${m}m ago`;if(h<24)return `${h}h ago`;if(dy<30)return `${dy}d ago`;return `${Math.floor(dy/30)}mo ago`;
}

function renderCard(level, index, total) {
  const W=800,H=220,PAD=24;
  const ORANGE="#f97316",NAVY="#0f172a",BORDER="#334155",TEXT="#f1f5f9",MUTED="#94a3b8",GOLD="#fbbf24";
  const ratio=Math.round((level.upvote_ratio??0)*100);
  const barW=Math.round((W-PAD*2-220)*(level.upvote_ratio??0));
  const barColor=ratio>=95?ORANGE:ratio>=80?GOLD:"#86efac";
  const flair=level.flair&&level.flair!=="none"?esc(trunc(level.flair,28)):null;
  const flairW=flair?Math.min(flair.length*8+24,200):0;
  const title=esc(trunc(level.title,60));
  const timeAgo=relTime(level.created_at);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${NAVY}"/><stop offset="100%" stop-color="#1a2540"/></linearGradient>
    <linearGradient id="stripe" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${ORANGE}"/><stop offset="100%" stop-color="#fb923c"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="8" fill="url(#bg)"/>
  <rect x="0" y="0" width="5" height="${H}" rx="3" fill="url(#stripe)"/>
  <rect x="5" y="0" width="${W-5}" height="2" fill="${ORANGE}" opacity="0.4"/>
  <rect x="${PAD+4}" y="${PAD}" width="44" height="24" rx="5" fill="${ORANGE}" opacity="0.15"/>
  <rect x="${PAD+4}" y="${PAD}" width="44" height="24" rx="5" stroke="${ORANGE}" stroke-width="1.2" fill="none"/>
  <text x="${PAD+26}" y="${PAD+16}" fill="${ORANGE}" font-size="11" font-weight="bold" text-anchor="middle">${index} / ${total}</text>
  <rect x="${W-PAD-72}" y="${PAD}" width="68" height="24" rx="5" fill="#1e293b"/>
  <rect x="${W-PAD-72}" y="${PAD}" width="68" height="24" rx="5" stroke="${BORDER}" stroke-width="1" fill="none"/>
  <text x="${W-PAD-38}" y="${PAD+16}" fill="${MUTED}" font-size="11" text-anchor="middle">r/honk</text>
  <text x="${PAD+58}" y="${PAD+18}" fill="${TEXT}" font-size="16" font-weight="bold">${title}</text>
  <text x="${PAD+58}" y="${PAD+42}" font-size="12" fill="${MUTED}"><tspan fill="${GOLD}" font-weight="bold">u/${esc(level.author)}</tspan><tspan fill="${MUTED}">  ·  ${timeAgo}</tspan></text>
  ${flair?`<rect x="${PAD+58}" y="${PAD+54}" width="${flairW}" height="18" rx="9" fill="${ORANGE}" opacity="0.15"/>
  <rect x="${PAD+58}" y="${PAD+54}" width="${flairW}" height="18" rx="9" stroke="${ORANGE}" stroke-width="0.8" fill="none"/>
  <text x="${PAD+58+flairW/2}" y="${PAD+67}" fill="${ORANGE}" font-size="10" font-weight="bold" text-anchor="middle">${flair}</text>`:""}
  <line x1="${PAD}" y1="${H-72}" x2="${W-PAD}" y2="${H-72}" stroke="${BORDER}" stroke-width="1"/>
  <text x="${PAD+8}" y="${H-50}" fill="${MUTED}" font-size="10" letter-spacing="1">SCORE</text>
  <text x="${PAD+8}" y="${H-30}" fill="${ORANGE}" font-size="18" font-weight="bold">${fmtNum(level.score)}</text>
  <text x="${PAD+90}" y="${H-50}" fill="${MUTED}" font-size="10" letter-spacing="1">COMMENTS</text>
  <text x="${PAD+90}" y="${H-30}" fill="${TEXT}" font-size="18" font-weight="bold">${fmtNum(level.num_comments)}</text>
  <text x="${PAD+220}" y="${H-50}" fill="${MUTED}" font-size="10" letter-spacing="1">UPVOTE RATIO</text>
  <text x="${PAD+220}" y="${H-30}" fill="${barColor}" font-size="18" font-weight="bold">${ratio}%</text>
  <rect x="${PAD+220}" y="${H-20}" width="${W-PAD*2-220}" height="6" rx="3" fill="${BORDER}"/>
  <rect x="${PAD+220}" y="${H-20}" width="${Math.max(barW,6)}" height="6" rx="3" fill="${barColor}"/>
  <text x="${W-PAD}" y="${H-8}" fill="${ORANGE}" font-size="10" text-anchor="end" opacity="0.7">${esc(trunc(level.url,55))}</text>
</svg>`;
}

function svgToPng(svg) {
  log("RENDER", "Converting SVG → PNG");
  const start = Date.now();
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1600 }, font: { loadSystemFonts: true } }).render().asPng();
  log("RENDER", `PNG done in ${Date.now()-start}ms — ${(png.length/1024).toFixed(1)}KB`);
  return png;
}

// ─── Results HTML page ────────────────────────────────────────────────────────
function buildResultsPage(query, levels, base) {
  const cards = levels.map((l, i) => {
    const flair    = l.flair ? `<span class="flair">${esc(l.flair)}</span>` : "";
    const preview  = l.selftext_preview ? `<p class="preview">${esc(l.selftext_preview)}</p>` : "";
    const ratio    = Math.round((l.upvote_ratio ?? 0) * 100);
    const imgUrl   = `${base}/card/${l.id}/png`;
    return `
    <div class="card">
      <a href="${esc(l.url)}" target="_blank" class="card-img-link">
        <img src="${imgUrl}" alt="${esc(trunc(l.title,72))}" loading="lazy"/>
      </a>
      <div class="card-body">
        <div class="card-top">
          <a href="${esc(l.url)}" target="_blank" class="title">${esc(l.title)}</a>
          ${flair}
        </div>
        <div class="meta">
          <span>👤 <strong>u/${esc(l.author)}</strong></span>
          <span>⬆ ${fmtNum(l.score)}</span>
          <span>💬 ${fmtNum(l.num_comments)}</span>
          <span>${ratio}% upvoted</span>
          <span>🕐 ${relTime(l.created_at)}</span>
        </div>
        ${preview}
        <a href="${esc(l.url)}" target="_blank" class="view-btn">View on Reddit ↗</a>
      </div>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>r/honk — "${esc(query)}" results</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f172a;
      color: #f1f5f9;
      font-family: 'Courier New', monospace;
      min-height: 100vh;
      padding: 0 0 60px;
    }
    header {
      background: #1e293b;
      border-bottom: 2px solid #f97316;
      padding: 24px 32px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    header .goose { font-size: 2.4rem; }
    header h1 { font-size: 1.4rem; color: #f97316; letter-spacing: 1px; }
    header p  { font-size: 0.85rem; color: #94a3b8; margin-top: 4px; }
    .badge {
      margin-left: auto;
      background: #f97316;
      color: #0f172a;
      font-weight: bold;
      font-size: 0.8rem;
      padding: 4px 12px;
      border-radius: 999px;
    }
    main { max-width: 900px; margin: 40px auto; padding: 0 20px; display: flex; flex-direction: column; gap: 24px; }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-left: 4px solid #f97316;
      border-radius: 8px;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .card:hover { border-color: #fbbf24; }
    .card-img-link img {
      width: 100%;
      display: block;
      border-bottom: 1px solid #334155;
    }
    .card-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
    .card-top { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
    .title {
      color: #f1f5f9;
      font-size: 1rem;
      font-weight: bold;
      text-decoration: none;
      flex: 1;
      line-height: 1.4;
    }
    .title:hover { color: #f97316; }
    .flair {
      background: rgba(249,115,22,0.15);
      border: 1px solid #f97316;
      color: #f97316;
      font-size: 0.72rem;
      padding: 2px 8px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      font-size: 0.8rem;
      color: #94a3b8;
    }
    .meta span strong { color: #fbbf24; }
    .preview {
      font-size: 0.82rem;
      color: #64748b;
      border-left: 2px solid #334155;
      padding-left: 10px;
      line-height: 1.5;
    }
    .view-btn {
      align-self: flex-start;
      background: transparent;
      border: 1px solid #f97316;
      color: #f97316;
      font-size: 0.78rem;
      font-family: 'Courier New', monospace;
      padding: 5px 14px;
      border-radius: 4px;
      text-decoration: none;
      letter-spacing: 0.5px;
      transition: background 0.15s, color 0.15s;
    }
    .view-btn:hover { background: #f97316; color: #0f172a; }
    .empty {
      text-align: center;
      padding: 80px 20px;
      color: #64748b;
      font-size: 1.1rem;
    }
    .empty .goose { font-size: 4rem; display: block; margin-bottom: 16px; }
    footer {
      text-align: center;
      margin-top: 48px;
      font-size: 0.75rem;
      color: #334155;
      letter-spacing: 1px;
    }
  </style>
</head>
<body>
  <header>
    <span class="goose">🪿</span>
    <div>
      <h1>r/honk level search</h1>
      <p>Results for: <strong style="color:#f1f5f9">${esc(query)}</strong></p>
    </div>
    <span class="badge">${levels.length} result${levels.length !== 1 ? "s" : ""}</span>
  </header>
  <main>
    ${levels.length === 0
      ? `<div class="empty"><span class="goose">🪿</span>No levels found for "${esc(query)}"</div>`
      : cards
    }
  </main>
  <footer>🪿 honk-render-server · r/honk level search</footer>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.json({ status: "ok" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── GET /results — HTML results page (linked from Discord embed title) ───────
app.get("/results", async (req, res) => {
  const query = (req.query.q ?? req.query.query ?? "").trim();
  const base  = process.env.BASE_URL ?? `${req.protocol}://${req.get("host")}`;
  log("RESULTS_PAGE", `Rendering results page for "${query}"`);

  if (!query) {
    return res.status(400).send("<h1>Missing ?q= param</h1>");
  }
  try {
    const levels = await searchLevels(query, 15);
    const html   = buildResultsPage(query, levels, base);
    res.setHeader("Content-Type", "text/html");
    return res.send(html);
  } catch (err) {
    log("RESULTS_PAGE_ERROR", err.message);
    return res.status(500).send(`<h1 style="color:red">Error: ${err.message}</h1>`);
  }
});

// ─── GET /search — JSON for BotGhost API request block ───────────────────────
app.get("/search", async (req, res) => {
  const query  = (req.query.q ?? req.query.query ?? "").trim();
  const limit  = Math.min(parseInt(req.query.limit) || 15, 15);
  const base   = process.env.BASE_URL ?? `${req.protocol}://${req.get("host")}`;
  const start  = Date.now();

  log("SEARCH", `Query: "${query}" limit: ${limit}`);

  if (!query) {
    log("SEARCH_ERROR", "Missing query param");
    return res.status(400).json({
      found: false, total: 0,
      message: "❌ Please provide a search query.",
      embed_title: "❌ Missing Query",
      embed_desc: "Use `/level_search` with a level name.",
      embed_url: "",
      embed_color: "15548997",
      embed_footer: "r/honk level search",
    });
  }

  try {
    const levels = await searchLevels(query, limit);

    // URL to the full HTML results page — used as the embed title URL
    const results_page_url = `${base}/results?q=${encodeURIComponent(query)}`;

    if (levels.length === 0) {
      log("SEARCH", `No results for "${query}"`);
      return res.json({
        found: false, total: 0,
        message: `🪿 No levels found for **${query}** in r/honk.`,
        embed_title: `🪿 No Results for "${query}"`,
        embed_desc: `Nothing found in r/honk matching **${query}**.\nTry a different search term.`,
        embed_url: results_page_url,
        embed_color: "16022038",
        embed_footer: "r/honk level search",
        first_card_url: "",
      });
    }

    // Build the formatted description — all results as Discord markdown
    const lines = levels.map((l, i) => {
      const flair   = l.flair ? ` \`${l.flair}\`` : "";
      const preview = l.selftext_preview ? `\n> ${l.selftext_preview.replace(/\n/g," ")}` : "";
      return [
        `**${i+1}. [${l.title}](${l.url})**${flair}`,
        `👤 u/${l.author}  ⬆ ${fmtNum(l.score)}  💬 ${fmtNum(l.num_comments)}  🕐 ${relTime(l.created_at)}`,
        preview,
      ].filter(Boolean).join("\n");
    });

    const embed_desc = lines.join("\n\n");

    const message = `🪿 **${levels.length} level(s) found for "${query}" in r/honk**\n\n` +
      levels.map((l,i) => `**${i+1}.** ${l.title} — u/${l.author} (⬆${fmtNum(l.score)})\n${l.url}`).join("\n\n");

    const payload = {
      found: true,
      total: levels.length,
      message,
      embed_title: `🪿 ${levels.length} result(s) for "${query}" in r/honk`,
      embed_desc,
      embed_url: results_page_url,   // ← clicking embed title opens the results page
      embed_color: "16022038",
      embed_footer: `${levels.length} result(s) · click title to view all cards`,
      first_card_url: `${base}/card/${levels[0].id}/png`,
      first_title:    levels[0].title,
      first_url:      levels[0].url,
      first_author:   levels[0].author,
      first_score:    levels[0].score,
      first_comments: levels[0].num_comments,
    };

    levels.forEach((l, i) => {
      const p = `r${i}_`;
      payload[`${p}title`]    = l.title;
      payload[`${p}author`]   = l.author;
      payload[`${p}score`]    = l.score;
      payload[`${p}comments`] = l.num_comments;
      payload[`${p}url`]      = l.url;
      payload[`${p}flair`]    = l.flair ?? "none";
      payload[`${p}preview`]  = l.selftext_preview ?? "";
      payload[`${p}card_url`] = `${base}/card/${l.id}/png`;
    });

    log("SEARCH", `Returning ${levels.length} results for "${query}" in ${Date.now()-start}ms`);
    return res.json(payload);

  } catch (err) {
    const elapsed  = Date.now() - start;
    const timedOut = err.code === "ECONNABORTED" || err.message.includes("timeout");
    log("SEARCH_ERROR", `${timedOut?"TIMEOUT":"FAILED"} after ${elapsed}ms: ${err.message}`);
    return res.status(timedOut ? 504 : 500).json({
      found: false, total: 0,
      message: timedOut ? "⏱️ Reddit took too long. Try again." : `❌ Search failed: ${err.message}`,
      embed_title: timedOut ? "⏱️ Timeout" : "❌ Error",
      embed_desc: timedOut ? "Reddit timed out. Try again in a moment." : err.message,
      embed_url: "",
      embed_color: "15548997",
      embed_footer: "r/honk level search",
    });
  }
});

// ─── GET /card/:postId/png ────────────────────────────────────────────────────
app.get("/card/:postId/png", async (req, res) => {
  const { postId } = req.params;
  const index = parseInt(req.query.index) || 1;
  const total = parseInt(req.query.total) || 1;
  const start = Date.now();
  log("CARD", `Rendering PNG for ${postId} (${index}/${total})`);
  try {
    const level = await getSinglePost(postId);
    const png   = svgToPng(renderCard(level, index, total));
    log("CARD", `Done in ${Date.now()-start}ms`);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(png);
  } catch (err) {
    log("CARD_ERROR", `Failed for ${postId}: ${err.message}`);
    return res.status(404).json({ error: err.message });
  }
});

// ─── GET /card/:postId/svg ────────────────────────────────────────────────────
app.get("/card/:postId/svg", async (req, res) => {
  const { postId } = req.params;
  log("CARD_SVG", `Rendering SVG for ${postId}`);
  try {
    const level = await getSinglePost(postId);
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(renderCard(level, parseInt(req.query.index)||1, parseInt(req.query.total)||1));
  } catch (err) {
    log("CARD_SVG_ERROR", `Failed: ${err.message}`);
    return res.status(404).json({ error: err.message });
  }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  log("404", `${req.method} ${req.path}`);
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

process.on("uncaughtException",  (err) => log("UNCAUGHT", err.message, { stack: err.stack }));
process.on("unhandledRejection", (r)   => log("UNHANDLED", String(r)));

app.listen(PORT, () => {
  log("STARTUP", `honk-render-server running on port ${PORT}`);
  log("STARTUP", "GET /search?q=...     → JSON for BotGhost");
  log("STARTUP", "GET /results?q=...    → HTML results page (embed title links here)");
  log("STARTUP", "GET /card/:id/png     → PNG card image");
  log("STARTUP", "GET /card/:id/svg     → SVG card (debug)");
});
