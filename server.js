import express from "express";
import axios from "axios";
import { Resvg } from "@resvg/resvg-js";

const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  next();
});
app.options("*", (_req, res) => res.sendStatus(200));

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(tag, msg, data = null) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tag}] ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

app.use((req, _res, next) => {
  log("REQUEST", `${req.method} ${req.path}`, {
    query:  req.query,
    body:   req.body,
    ip:     req.headers["x-forwarded-for"] ?? req.socket.remoteAddress,
    ua:     req.headers["user-agent"],
  });
  next();
});

// ─── Query extractor — works for GET params AND POST JSON body ────────────────
// GET  /search?q=Rollercoaster
// GET  /search?query=Rollercoaster
// POST /search  body: { "query": "Rollercoaster" }
// POST /search  body: { "q": "Rollercoaster" }
function getQuery(req) {
  return (
    req.body?.query   ??
    req.body?.q       ??
    req.query?.q      ??
    req.query?.query  ??
    ""
  ).trim();
}

function getSubreddit(req) {
  const raw = (
    req.body?.subreddit  ??
    req.query?.subreddit ??
    req.body?.sub        ??
    req.query?.sub       ??
    "honk"
  ).trim().replace(/^r\//i, ""); // strip r/ prefix if user typed it
  // sanitise — only allow alphanumeric and underscores
  return raw.replace(/[^a-zA-Z0-9_]/g, "") || "honk";
}

function getLimit(req) {
  const raw = req.body?.limit ?? req.query?.limit;
  return Math.min(parseInt(raw) || 15, 15);
}

function getBase(req) {
  const host = req.get("host");
  return process.env.BASE_URL ?? `https://${host}`;
}

// ─── Reddit ───────────────────────────────────────────────────────────────────
// ─── Rotating user agents ─────────────────────────────────────────────────────
const USER_AGENTS = [
  "web:honk-level-search:v1.0 (by /u/Damp_Blanket)",
  "web:honk-level-search:v1.0 (by /u/W6716)",
  "web:honk-level-search:v1.0 (by /u/SlavBoii420)",
  "web:honk-level-search:v1.0 (by /u/st_doraemon)",
];
let uaIndex = 0;
function nextUA() {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex = (uaIndex + 1) % USER_AGENTS.length;
  log("UA", `Using ${ua}`);
  return ua;
}

const redditClient = axios.create({
  baseURL: "https://www.reddit.com",
  headers: { "Accept": "application/json" },
  timeout: 12_000,
});

// Inject rotating UA on every request
redditClient.interceptors.request.use(config => {
  config.headers["User-Agent"] = nextUA();
  return config;
});

function normalisePost(post) {
  let imageUrl = null;
  if (post.thumbnail && !["self","default","nsfw",""].includes(post.thumbnail)) imageUrl = post.thumbnail;
  if (post.preview?.images?.[0]?.source?.url) imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, "&");
  return {
    id:               post.id,
    title:            post.title,
    author:           post.author,
    score:            post.score,
    upvote_ratio:     post.upvote_ratio,
    num_comments:     post.num_comments,
    created_at:       new Date(post.created_utc * 1000).toISOString(),
    url:              `https://reddit.com${post.permalink}`,
    flair:            post.link_flair_text ?? null,
    selftext_preview: post.selftext?.slice(0, 150) ?? null,
    image_url:        imageUrl,
    subreddit:        post.subreddit ?? "honk",
  };
}

async function searchLevels(query, limit = 15, subreddit = "honk") {
  log("REDDIT", `Searching r/${subreddit} for "${query}" limit ${limit}`);
  const start = Date.now();
  try {
    const res = await redditClient.get(`/r/${subreddit}/search.json`, {
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
    const ms = Date.now() - start;
    if (err.code === "ECONNABORTED")  log("REDDIT_ERROR", `TIMED OUT after ${ms}ms`);
    else if (err.response?.status === 429) log("REDDIT_ERROR", `RATE LIMITED (429) after ${ms}ms`);
    else if (err.response)            log("REDDIT_ERROR", `HTTP ${err.response.status} after ${ms}ms`);
    else                              log("REDDIT_ERROR", `FAILED after ${ms}ms: ${err.message}`);
    throw err;
  }
}

async function getSinglePost(postId, subreddit = "honk") {
  const id = postId.replace(/^t3_/, "");
  log("REDDIT", `Fetching single post ${id} from r/${subreddit}`);
  const start = Date.now();
  try {
    const res  = await redditClient.get(`/r/${subreddit}/comments/${id}.json`, { params: { limit: 1 } });
    const post = res.data?.[0]?.data?.children?.[0]?.data;
    if (!post) throw new Error(`Post ${id} not found`);
    log("REDDIT", `Fetched "${post.title}" in ${Date.now()-start}ms`);
    return normalisePost(post);
  } catch (err) {
    log("REDDIT_ERROR", `FAILED after ${Date.now()-start}ms: ${err.message}`);
    throw err;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(s)    { return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function trunc(s,n){ return s?.length>n ? s.slice(0,n-1)+"…":(s??""); }
function fmtNum(n) { return n>=1000?(n/1000).toFixed(1)+"k":String(n); }
function relTime(iso) {
  const d=Date.now()-new Date(iso).getTime(),m=Math.floor(d/60000),h=Math.floor(d/3600000),dy=Math.floor(d/86400000);
  if(m<60)  return `${m}m ago`;
  if(h<24)  return `${h}h ago`;
  if(dy<30) return `${dy}d ago`;
  return `${Math.floor(dy/30)}mo ago`;
}

// ─── SVG card renderer ────────────────────────────────────────────────────────
function renderCard(level, index, total) {
  const W=800,H=220,PAD=24;
  const ORANGE="#f97316",NAVY="#0f172a",BORDER="#334155",TEXT="#f1f5f9",MUTED="#94a3b8",GOLD="#fbbf24";
  const ratio    = Math.round((level.upvote_ratio??0)*100);
  const barW     = Math.round((W-PAD*2-220)*(level.upvote_ratio??0));
  const barColor = ratio>=95 ? ORANGE : ratio>=80 ? GOLD : "#86efac";
  const flair    = level.flair && level.flair!=="none" ? esc(trunc(level.flair,28)) : null;
  const flairW   = flair ? Math.min(flair.length*8+24, 200) : 0;

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
  <text x="${W-PAD-38}" y="${PAD+16}" fill="${MUTED}" font-size="11" text-anchor="middle">r/${esc(level.subreddit??"honk")}</text>
  <text x="${PAD+58}" y="${PAD+18}" fill="${TEXT}" font-size="16" font-weight="bold">${esc(trunc(level.title,60))}</text>
  <text x="${PAD+58}" y="${PAD+42}" font-size="12" fill="${MUTED}">
    <tspan fill="${GOLD}" font-weight="bold">u/${esc(level.author)}</tspan>
    <tspan fill="${MUTED}">  ·  ${relTime(level.created_at)}</tspan>
  </text>
  ${flair ? `
  <rect x="${PAD+58}" y="${PAD+54}" width="${flairW}" height="18" rx="9" fill="${ORANGE}" opacity="0.15"/>
  <rect x="${PAD+58}" y="${PAD+54}" width="${flairW}" height="18" rx="9" stroke="${ORANGE}" stroke-width="0.8" fill="none"/>
  <text x="${PAD+58+flairW/2}" y="${PAD+67}" fill="${ORANGE}" font-size="10" font-weight="bold" text-anchor="middle">${flair}</text>
  ` : ""}
  <line x1="${PAD}" y1="${H-72}" x2="${W-PAD}" y2="${H-72}" stroke="${BORDER}" stroke-width="1"/>
  <text x="${PAD+8}"   y="${H-50}" fill="${MUTED}"     font-size="10" letter-spacing="1">SCORE</text>
  <text x="${PAD+8}"   y="${H-30}" fill="${ORANGE}"    font-size="18" font-weight="bold">${fmtNum(level.score)}</text>
  <text x="${PAD+90}"  y="${H-50}" fill="${MUTED}"     font-size="10" letter-spacing="1">COMMENTS</text>
  <text x="${PAD+90}"  y="${H-30}" fill="${TEXT}"      font-size="18" font-weight="bold">${fmtNum(level.num_comments)}</text>
  <text x="${PAD+220}" y="${H-50}" fill="${MUTED}"     font-size="10" letter-spacing="1">UPVOTE RATIO</text>
  <text x="${PAD+220}" y="${H-30}" fill="${barColor}"  font-size="18" font-weight="bold">${ratio}%</text>
  <rect x="${PAD+220}" y="${H-20}" width="${W-PAD*2-220}"      height="6" rx="3" fill="${BORDER}"/>
  <rect x="${PAD+220}" y="${H-20}" width="${Math.max(barW,6)}" height="6" rx="3" fill="${barColor}"/>
  <text x="${W-PAD}" y="${H-8}" fill="${ORANGE}" font-size="10" text-anchor="end" opacity="0.7">${esc(trunc(level.url,55))}</text>
</svg>`;
}

function svgToPng(svg) {
  log("RENDER", "Converting SVG → PNG");
  const start = Date.now();
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: 1600 },
    font:  { loadSystemFonts: true },
  }).render().asPng();
  log("RENDER", `PNG done in ${Date.now()-start}ms — ${(png.length/1024).toFixed(1)}KB`);
  return png;
}

// ─── Results HTML page ────────────────────────────────────────────────────────
function buildResultsPage(query, levels, base) {
  const cards = levels.map((l) => {
    const flair   = l.flair ? `<span class="flair">${esc(l.flair)}</span>` : "";
    const preview = l.selftext_preview ? `<p class="preview">${esc(l.selftext_preview)}</p>` : "";
    const ratio   = Math.round((l.upvote_ratio ?? 0) * 100);
    return `<div class="card">
      <a href="${esc(l.url)}" target="_blank" class="card-img-link">
        <img src="${base}/card/${l.id}/png" alt="${esc(trunc(l.title,72))}" loading="lazy"/>
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
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>r/honk — "${esc(query)}"</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f172a;color:#f1f5f9;font-family:'Courier New',monospace;min-height:100vh;padding-bottom:60px}
    header{background:#1e293b;border-bottom:2px solid #f97316;padding:24px 32px;display:flex;align-items:center;gap:16px}
    header .goose{font-size:2.4rem}
    header h1{font-size:1.4rem;color:#f97316;letter-spacing:1px}
    header p{font-size:0.85rem;color:#94a3b8;margin-top:4px}
    .badge{margin-left:auto;background:#f97316;color:#0f172a;font-weight:bold;font-size:0.8rem;padding:4px 12px;border-radius:999px}
    main{max-width:900px;margin:40px auto;padding:0 20px;display:flex;flex-direction:column;gap:24px}
    .card{background:#1e293b;border:1px solid #334155;border-left:4px solid #f97316;border-radius:8px;overflow:hidden;transition:border-color .2s}
    .card:hover{border-color:#fbbf24}
    .card-img-link img{width:100%;display:block;border-bottom:1px solid #334155}
    .card-body{padding:16px 20px;display:flex;flex-direction:column;gap:10px}
    .card-top{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
    .title{color:#f1f5f9;font-size:1rem;font-weight:bold;text-decoration:none;flex:1;line-height:1.4}
    .title:hover{color:#f97316}
    .flair{background:rgba(249,115,22,.15);border:1px solid #f97316;color:#f97316;font-size:.72rem;padding:2px 8px;border-radius:999px;white-space:nowrap}
    .meta{display:flex;flex-wrap:wrap;gap:14px;font-size:.8rem;color:#94a3b8}
    .meta span strong{color:#fbbf24}
    .preview{font-size:.82rem;color:#64748b;border-left:2px solid #334155;padding-left:10px;line-height:1.5}
    .view-btn{align-self:flex-start;background:transparent;border:1px solid #f97316;color:#f97316;font-size:.78rem;font-family:'Courier New',monospace;padding:5px 14px;border-radius:4px;text-decoration:none;letter-spacing:.5px;transition:background .15s,color .15s}
    .view-btn:hover{background:#f97316;color:#0f172a}
    footer{text-align:center;margin-top:48px;font-size:.75rem;color:#334155;letter-spacing:1px}
  </style>
</head>
<body>
  <header>
    <span class="goose">🪿</span>
    <div>
      <h1>r/honk level search</h1>
      <p>Results for: <strong style="color:#f1f5f9">${esc(query)}</strong></p>
    </div>
    <span class="badge">${levels.length} result${levels.length!==1?"s":""}</span>
  </header>
  <main>${levels.length===0
    ? `<div style="text-align:center;padding:80px 20px;color:#64748b">🪿 No levels found for "${esc(query)}"</div>`
    : cards
  }</main>
  <footer>🪿 honk-render-server · r/honk level search</footer>
</body>
</html>`;
}

// ─── Payload builder ──────────────────────────────────────────────────────────
function buildPayload(query, levels, base, subreddit = "honk", difficulty = null) {
  const results_page_url = `${base}/results?q=${encodeURIComponent(query)}&sub=${encodeURIComponent(subreddit)}`;
  const diffLabel = difficulty ? ` [${difficulty}]` : "";

  if (levels.length === 0) {
    return `No levels found for "${query}" in r/${subreddit}${diffLabel}. Try a different search term or difficulty.\n\n${results_page_url}`;
  }

  const lines = levels.map((l, i) => {
    const flair = l.flair && l.flair !== "none" ? ` [${l.flair}]` : "";
    return [
      `${i+1}. ${l.title}${flair}`,
      `by u/${l.author} | Score: ${fmtNum(l.score)} | Comments: ${fmtNum(l.num_comments)} | ${relTime(l.created_at)}`,
      l.url,
    ].join("\n");
  });

  return [
    `${levels.length} result(s) for "${query}" in r/${subreddit}${diffLabel}`,
    `Full results + cards: ${results_page_url}`,
    `---`,
    lines.join("\n\n"),
  ].join("\n");
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/",       (_req, res) => res.json({ status: "ok" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// GET /results?q=... — HTML page linked from embed title
app.get("/results", async (req, res) => {
  const query     = (req.query.q ?? req.query.query ?? "").trim();
  const subreddit = (req.query.sub ?? req.query.subreddit ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  const base      = getBase(req);
  log("RESULTS_PAGE", `Rendering HTML page for "${query}" in r/${subreddit}`);
  if (!query) return res.status(400).send("<h1>Missing ?q= param</h1>");
  try {
    const levels = await searchLevels(query, 15, subreddit);
    res.setHeader("Content-Type", "text/html");
    return res.send(buildResultsPage(query, levels, base));
  } catch (err) {
    log("RESULTS_PAGE_ERROR", err.message);
    return res.status(500).send(`<h1 style="color:red">Error: ${err.message}</h1>`);
  }
});

// GET /search?q=...  OR  POST /search  body: { "query": "..." }
async function handleSearch(req, res) {
  const query = getQuery(req);
  const limit = getLimit(req);
  const base  = getBase(req);
  const start = Date.now();

  log("SEARCH", `Method: ${req.method} | Query: "${query}" | Limit: ${limit}`);

  if (!query) {
    log("SEARCH_ERROR", "Rejected — query is empty or missing");
    return res.status(400).json({
      found:       false,
      total:       0,
      embed_title: "❌ Missing query",
      embed_desc:  "Provide a level name to search for.",
      embed_url:   "",
      embed_color: "#ef4444",
      embed_footer:"r/honk level search",
    });
  }

  try {
    const levels  = await searchLevels(query, limit);
    const response = buildPayload(query, levels, base);
    log("SEARCH", `Done in ${Date.now()-start}ms — returning ${levels.length} results`);
    // Return as plain text string so BotGhost {honk.response} works directly
    return res.send(response);
  } catch (err) {
    const ms       = Date.now() - start;
    const timedOut = err.code === "ECONNABORTED" || err.message.includes("timeout");
    const limited  = err.response?.status === 429;
    log("SEARCH_ERROR", `${timedOut?"TIMEOUT":limited?"RATE_LIMITED":"FAILED"} after ${ms}ms: ${err.message}`);
    return res.status(timedOut ? 504 : limited ? 429 : 500).json({
      found:       false,
      total:       0,
      embed_title: timedOut ? "⏱️ Timeout" : limited ? "🚦 Rate Limited" : "❌ Error",
      embed_desc:  timedOut ? "Reddit took too long. Try again in a moment."
                 : limited  ? "Too many requests to Reddit. Try again in 30 seconds."
                 :            `Search failed: ${err.message}`,
      embed_url:   "",
      embed_color: "#ef4444",
      embed_footer:"r/honk level search",
    });
  }
}

app.get("/search",  handleSearch);
app.post("/search", handleSearch);

// GET /card/:postId/png — PNG card image
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

// GET /card/:postId/svg — raw SVG for debugging
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

// ─── GET /image?q=... — returns the first result's PNG card directly ───────────
// BotGhost Image URL field: https://honk-bot.onrender.com/image?q={option_query}
app.get("/image", async (req, res) => {
  const query     = (req.query.q ?? req.query.query ?? "").trim();
  const subreddit = (req.query.sub ?? req.query.subreddit ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  log("IMAGE", `Fetching first result image for "${query}" in r/${subreddit}`);
  if (!query) return res.status(400).send("Missing ?q= param");
  try {
    const levels = await searchLevels(query, 1, subreddit);
    if (levels.length === 0) {
      // Return a simple "no results" PNG card
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="220" font-family="sans-serif">
        <rect width="800" height="220" rx="8" fill="#0f172a"/>
        <rect x="0" y="0" width="5" height="220" fill="#f97316"/>
        <text x="400" y="100" fill="#94a3b8" font-size="24" text-anchor="middle">🪿 No results found</text>
        <text x="400" y="135" fill="#64748b" font-size="16" text-anchor="middle">Nothing in r/honk matching "${esc(query)}"</text>
      </svg>`;
      const png = svgToPng(svg);
      res.setHeader("Content-Type", "image/png");
      return res.end(png);
    }
    const png = svgToPng(renderCard(levels[0], 1, 1));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(png);
  } catch (err) {
    log("IMAGE_ERROR", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /title?q=... — returns plain text title for first result ─────────────
// Useful for embed title field if BotGhost ever supports URL-fetched text
app.get("/title", async (req, res) => {
  const query = (req.query.q ?? req.query.query ?? "").trim();
  log("TITLE", `Fetching title for "${query}"`);
  if (!query) return res.status(400).send("Missing ?q= param");
  try {
    const levels = await searchLevels(query, 1);
    const text = levels.length > 0
      ? `🪿 ${levels.length > 1 ? "15" : "1"} result(s) for "${query}" in r/honk`
      : `🪿 No results for "${query}" in r/honk`;
    res.setHeader("Content-Type", "text/plain");
    return res.send(text);
  } catch (err) {
    res.status(500).send("Error");
  }
});


// ─── Difficulty filter helper ─────────────────────────────────────────────────
const DIFFICULTIES = [
  "🍰 VERY EASY",
  "🟢 EASY",
  "🟡 MEDIUM",
  "🔴 HARD",
  "🔥 INSANE",
  "💀🔥 NEAR IMPOSSIBLE",
  "🔥💀🔥 IMPOSSIBLE",
];

function getDifficulty(req) {
  const raw = (req.body?.difficulty ?? req.query?.difficulty ?? "").trim();
  if (!raw) return null;
  // case-insensitive match against known difficulties
  const match = DIFFICULTIES.find(d => d.toLowerCase() === raw.toLowerCase());
  return match ?? null;
}

function filterByDifficulty(posts, difficulty) {
  if (!difficulty) return posts;
  return posts.filter(p => {
    const flair = (p.flair ?? "").toLowerCase().trim();
    return flair === difficulty.toLowerCase().trim();
  });
}

// ─── GET /user — posts by a specific reddit user ──────────────────────────────
// GET /user?u=RecognitionPatient12&difficulty=🔴 HARD&sub=honk
app.get("/user", async (req, res) => {
  const username   = (req.body?.u ?? req.query?.u ?? req.query?.username ?? "").trim().replace(/^u\//i, "");
  const difficulty = getDifficulty(req);
  const subreddit  = (req.query.sub ?? req.query.subreddit ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  const base       = getBase(req);
  const start      = Date.now();

  log("USER", `Fetching levels by u/${username} in r/${subreddit}${difficulty ? ` filtered by "${difficulty}"` : ""}`);

  if (!username) {
    return res.status(400).send("Missing ?u= param (reddit username)");
  }

  try {
    // Search for posts by this author using Reddit's author: filter
    const res2 = await redditClient.get(`/r/${subreddit}/search.json`, {
      params: {
        q:           `author:${username}`,
        restrict_sr: 1,
        sort:        "top",
        type:        "link",
        limit:       50,
        t:           "all",
      },
    });

    let posts = (res2.data?.data?.children ?? [])
      .map(c => c.data)
      .filter(p => !p.removed_by_category)
      .map(normalisePost);

    const total_before_filter = posts.length;
    posts = filterByDifficulty(posts, difficulty).slice(0, 15);

    log("USER", `Got ${total_before_filter} posts, ${posts.length} after filter in ${Date.now()-start}ms`);

    if (posts.length === 0) {
      const reason = difficulty
        ? `No ${difficulty} levels found by u/${username} in r/${subreddit}.`
        : `No levels found by u/${username} in r/${subreddit}.`;
      return res.send(reason);
    }

    const results_page_url = `${base}/results?q=author:${encodeURIComponent(username)}&sub=${encodeURIComponent(subreddit)}`;

    const lines = posts.map((l, i) => {
      const flair = l.flair && l.flair !== "none" ? ` [${l.flair}]` : "";
      return [
        `${i+1}. ${l.title}${flair}`,
        `Score: ${fmtNum(l.score)} | Comments: ${fmtNum(l.num_comments)} | ${relTime(l.created_at)}`,
        l.url,
      ].join("\n");
    });

    return res.send([
      `${posts.length} level(s) by u/${username} in r/${subreddit}${difficulty ? ` [${difficulty}]` : ""}`,
      `Full results: ${results_page_url}`,
      "---",
      lines.join("\n\n"),
    ].join("\n"));

  } catch (err) {
    const ms = Date.now() - start;
    log("USER_ERROR", `FAILED after ${ms}ms: ${err.message}`);
    return res.status(500).send(`Error fetching levels: ${err.message}`);
  }
});

// ─── GET /top — top scoring posts ────────────────────────────────────────────
// GET /top?timeframe=week&difficulty=🔥 INSANE&sub=honk
// timeframe: day | week | month | all (default all)
app.get("/top", async (req, res) => {
  const rawTime    = (req.query.timeframe ?? req.body?.timeframe ?? "all").toLowerCase().trim();
  const difficulty = getDifficulty(req);
  const subreddit  = (req.query.sub ?? req.query.subreddit ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  const base       = getBase(req);
  const start      = Date.now();

  // Normalise timeframe to Reddit's t= param
  const timeMap = { today: "day", day: "day", week: "week", month: "month", year: "year", all: "all", "all time": "all" };
  const t = timeMap[rawTime] ?? "all";
  const timeLabel = { day:"Today", week:"This Week", month:"This Month", year:"This Year", all:"All Time" }[t];

  log("TOP", `Fetching top posts in r/${subreddit} t=${t}${difficulty ? ` filtered by "${difficulty}"` : ""}`);

  try {
    const res2 = await redditClient.get(`/r/${subreddit}/top.json`, {
      params: { t, limit: 50 },
    });

    let posts = (res2.data?.data?.children ?? [])
      .map(c => c.data)
      .filter(p => !p.removed_by_category)
      .map(normalisePost);

    const total_before_filter = posts.length;
    posts = filterByDifficulty(posts, difficulty).slice(0, 15);

    log("TOP", `Got ${total_before_filter} posts, ${posts.length} after filter in ${Date.now()-start}ms`);

    if (posts.length === 0) {
      const reason = difficulty
        ? `No ${difficulty} levels in the top of r/${subreddit} for ${timeLabel}.`
        : `No top levels found in r/${subreddit} for ${timeLabel}.`;
      return res.send(reason);
    }

    const results_page_url = `${base}/results?q=*&sub=${encodeURIComponent(subreddit)}`;

    const lines = posts.map((l, i) => {
      const flair = l.flair && l.flair !== "none" ? ` [${l.flair}]` : "";
      return [
        `${i+1}. ${l.title}${flair}`,
        `Score: ${fmtNum(l.score)} | Comments: ${fmtNum(l.num_comments)} | ${relTime(l.created_at)}`,
        `by u/${l.author}`,
        l.url,
      ].join("\n");
    });

    return res.send([
      `Top ${posts.length} level(s) in r/${subreddit} — ${timeLabel}${difficulty ? ` [${difficulty}]` : ""}`,
      `Full results: ${results_page_url}`,
      "---",
      lines.join("\n\n"),
    ].join("\n"));

  } catch (err) {
    const ms = Date.now() - start;
    log("TOP_ERROR", `FAILED after ${ms}ms: ${err.message}`);
    return res.status(500).send(`Error fetching top levels: ${err.message}`);
  }
});

// 404
app.use((req, res) => {
  log("404", `${req.method} ${req.path}`);
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

process.on("uncaughtException",  (err) => log("UNCAUGHT",  err.message, { stack: err.stack }));
process.on("unhandledRejection", (r)   => log("UNHANDLED", String(r)));

app.listen(PORT, () => {
  log("STARTUP", `honk-render-server running on port ${PORT}`);
  log("STARTUP", "GET  /search?q=...&sub=...          JSON for BotGhost");
  log("STARTUP", "POST /search  {query:...,subreddit:...}  JSON for BotGhost");
  log("STARTUP", "GET  /results?q=...&sub=...         HTML results page");
  log("STARTUP", "GET  /image?q=...&sub=...           PNG card for first result");
  log("STARTUP", "GET  /card/:id/png                  PNG card image");
  log("STARTUP", "GET  /card/:id/svg                  SVG card (debug)");
  log("STARTUP", "GET  /user?u=...&difficulty=...     Levels by user");
  log("STARTUP", "GET  /top?timeframe=...&difficulty=... Top levels");
});
