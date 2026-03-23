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
    query: req.query, body: req.body,
    ip: req.headers["x-forwarded-for"] ?? req.socket.remoteAddress,
    ua: req.headers["user-agent"],
  });
  next();
});

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
  log("UA", ua);
  return ua;
}

// ─── Reddit client ────────────────────────────────────────────────────────────
const redditClient = axios.create({
  baseURL: "https://www.reddit.com",
  headers: { "Accept": "application/json" },
  timeout: 12_000,
});
redditClient.interceptors.request.use(config => {
  config.headers["User-Agent"] = nextUA();
  return config;
});

// ─── Difficulties ─────────────────────────────────────────────────────────────
const DIFFICULTIES = [
  "🍰 VERY EASY", "🟢 EASY", "🟡 MEDIUM", "🔴 HARD",
  "🔥 INSANE", "💀🔥 NEAR IMPOSSIBLE", "🔥💀🔥 IMPOSSIBLE",
];

// ─── Param helpers ────────────────────────────────────────────────────────────
function getQuery(req) {
  return (req.body?.query ?? req.body?.q ?? req.query?.q ?? req.query?.query ?? "").trim();
}
// Subreddit, limit, difficulty hardcoded — BotGhost optional params break response format
function getSubreddit() { return "honk"; }
function getLimit()     { return 5; }
function getDifficulty(){ return null; }
function getBase(req) {
  return process.env.BASE_URL ?? `https://${req.get("host")}`;
}

// ─── Reddit ───────────────────────────────────────────────────────────────────
function normalisePost(post) {
  let imageUrl = null;
  if (post.thumbnail && !["self","default","nsfw",""].includes(post.thumbnail)) imageUrl = post.thumbnail;
  if (post.preview?.images?.[0]?.source?.url) imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, "&");
  return {
    id:           post.id,
    title:        post.title,
    author:       post.author,
    score:        post.score,
    upvote_ratio: post.upvote_ratio ?? 0,
    num_comments: post.num_comments,
    created_at:   new Date(post.created_utc * 1000).toISOString(),
    url:          `https://reddit.com${post.permalink}`,
    flair:        post.link_flair_text ?? null,
    image_url:    imageUrl,
    subreddit:    post.subreddit ?? "honk",
  };
}
function filterByDifficulty(posts, difficulty) {
  if (!difficulty) return posts;
  return posts.filter(p => (p.flair ?? "").toLowerCase().trim() === difficulty.toLowerCase().trim());
}
async function searchLevels(query, limit = 5, subreddit = "honk") {
  log("REDDIT", `Searching r/${subreddit} for "${query}" limit ${limit}`);
  const start = Date.now();
  try {
    const res = await redditClient.get(`/r/${subreddit}/search.json`, {
      params: { q: query, restrict_sr: 1, sort: "relevance", type: "link", limit: 50, t: "all" },
    });
    const posts = (res.data?.data?.children ?? [])
      .map(c => c.data).filter(p => !p.removed_by_category).map(normalisePost);
    log("REDDIT", `Got ${posts.length} results in ${Date.now()-start}ms`);
    return posts;
  } catch (err) {
    const ms = Date.now() - start;
    if (err.code === "ECONNABORTED")       log("REDDIT_ERROR", `TIMED OUT after ${ms}ms`);
    else if (err.response?.status === 429) log("REDDIT_ERROR", `RATE LIMITED after ${ms}ms`);
    else if (err.response)                 log("REDDIT_ERROR", `HTTP ${err.response.status} after ${ms}ms`);
    else                                   log("REDDIT_ERROR", `FAILED after ${ms}ms: ${err.message}`);
    throw err;
  }
}
async function getSinglePost(postId, subreddit = "honk") {
  const id = postId.replace(/^t3_/, "");
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

// ─── Response formatter ───────────────────────────────────────────────────────
// Default 5 results. Max 15 with a warning baked in. Hard cap at 1900 chars.
function formatPosts(header, posts, resultsUrl, limit) {
  const warning = limit > 5 ? "\n⚠️ More than 5 results requested — may be cut off." : "";
  if (posts.length === 0) return `${header}${warning}\nNo results found.\n${resultsUrl}`;
  const lines = posts.map((l, i) => {
    const flair = l.flair && l.flair !== "none" ? ` [${l.flair}]` : "";
    return `${i+1}. ${trunc(l.title, 55)}${flair}\nu/${l.author} | ⬆${fmtNum(l.score)} | 💬${fmtNum(l.num_comments)} | ${relTime(l.created_at)}\n${l.url}`;
  });
  const body = `${header}${warning}\n${resultsUrl}\n\n${lines.join("\n\n")}`;
  return body.length > 1900 ? body.slice(0, 1880) + "\n…(truncated — use /results page)" : body;
}

// ─── SVG card renderer ────────────────────────────────────────────────────────
function renderCard(level, index, total) {
  const W=800,H=220,PAD=24;
  const ORANGE="#f97316",NAVY="#0f172a",BORDER="#334155",TEXT="#f1f5f9",MUTED="#94a3b8",GOLD="#fbbf24";
  const ratio    = Math.round((level.upvote_ratio??0)*100);
  const barW     = Math.round((W-PAD*2-220)*(level.upvote_ratio??0));
  const barColor = ratio>=95?ORANGE:ratio>=80?GOLD:"#86efac";
  const flair    = level.flair&&level.flair!=="none"?esc(trunc(level.flair,28)):null;
  const flairW   = flair?Math.min(flair.length*8+24,200):0;
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
  <text x="${PAD+58}" y="${PAD+42}" font-size="12" fill="${MUTED}"><tspan fill="${GOLD}" font-weight="bold">u/${esc(level.author)}</tspan><tspan fill="${MUTED}">  ·  ${relTime(level.created_at)}</tspan></text>
  ${flair?`<rect x="${PAD+58}" y="${PAD+54}" width="${flairW}" height="18" rx="9" fill="${ORANGE}" opacity="0.15"/>
  <rect x="${PAD+58}" y="${PAD+54}" width="${flairW}" height="18" rx="9" stroke="${ORANGE}" stroke-width="0.8" fill="none"/>
  <text x="${PAD+58+flairW/2}" y="${PAD+67}" fill="${ORANGE}" font-size="10" font-weight="bold" text-anchor="middle">${flair}</text>`:""}
  <line x1="${PAD}" y1="${H-72}" x2="${W-PAD}" y2="${H-72}" stroke="${BORDER}" stroke-width="1"/>
  <text x="${PAD+8}"   y="${H-50}" fill="${MUTED}"    font-size="10" letter-spacing="1">SCORE</text>
  <text x="${PAD+8}"   y="${H-30}" fill="${ORANGE}"   font-size="18" font-weight="bold">${fmtNum(level.score)}</text>
  <text x="${PAD+90}"  y="${H-50}" fill="${MUTED}"    font-size="10" letter-spacing="1">COMMENTS</text>
  <text x="${PAD+90}"  y="${H-30}" fill="${TEXT}"     font-size="18" font-weight="bold">${fmtNum(level.num_comments)}</text>
  <text x="${PAD+220}" y="${H-50}" fill="${MUTED}"    font-size="10" letter-spacing="1">UPVOTE RATIO</text>
  <text x="${PAD+220}" y="${H-30}" fill="${barColor}" font-size="18" font-weight="bold">${ratio}%</text>
  <rect x="${PAD+220}" y="${H-20}" width="${W-PAD*2-220}"      height="6" rx="3" fill="${BORDER}"/>
  <rect x="${PAD+220}" y="${H-20}" width="${Math.max(barW,6)}" height="6" rx="3" fill="${barColor}"/>
  <text x="${W-PAD}" y="${H-8}" fill="${ORANGE}" font-size="10" text-anchor="end" opacity="0.7">${esc(trunc(level.url,55))}</text>
</svg>`;
}
function svgToPng(svg) {
  const start = Date.now();
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1600 }, font: { loadSystemFonts: true } }).render().asPng();
  log("RENDER", `PNG done in ${Date.now()-start}ms — ${(png.length/1024).toFixed(1)}KB`);
  return png;
}

// ─── Results HTML page ────────────────────────────────────────────────────────
function buildResultsPage(query, levels, base, subreddit) {
  const cards = levels.map(l => {
    const flair   = l.flair?`<span class="flair">${esc(l.flair)}</span>`:"";
    const ratio   = Math.round((l.upvote_ratio??0)*100);
    return `<div class="card">
      <a href="${esc(l.url)}" target="_blank" class="card-img-link">
        <img src="${base}/card/${l.id}/png" alt="${esc(trunc(l.title,72))}" loading="lazy"/>
      </a>
      <div class="card-body">
        <div class="card-top"><a href="${esc(l.url)}" target="_blank" class="title">${esc(l.title)}</a>${flair}</div>
        <div class="meta">
          <span>👤 <strong>u/${esc(l.author)}</strong></span>
          <span>⬆ ${fmtNum(l.score)}</span>
          <span>💬 ${fmtNum(l.num_comments)}</span>
          <span>${ratio}% upvoted</span>
          <span>🕐 ${relTime(l.created_at)}</span>
        </div>
        <a href="${esc(l.url)}" target="_blank" class="view-btn">View on Reddit ↗</a>
      </div>
    </div>`;
  }).join("\n");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>r/${esc(subreddit)} — ${esc(query)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#f1f5f9;font-family:'Courier New',monospace;padding-bottom:60px}
header{background:#1e293b;border-bottom:2px solid #f97316;padding:24px 32px;display:flex;align-items:center;gap:16px}
header .goose{font-size:2.4rem}header h1{font-size:1.4rem;color:#f97316;letter-spacing:1px}
header p{font-size:.85rem;color:#94a3b8;margin-top:4px}
.badge{margin-left:auto;background:#f97316;color:#0f172a;font-weight:bold;font-size:.8rem;padding:4px 12px;border-radius:999px}
main{max-width:900px;margin:40px auto;padding:0 20px;display:flex;flex-direction:column;gap:24px}
.card{background:#1e293b;border:1px solid #334155;border-left:4px solid #f97316;border-radius:8px;overflow:hidden;transition:border-color .2s}
.card:hover{border-color:#fbbf24}.card-img-link img{width:100%;display:block;border-bottom:1px solid #334155}
.card-body{padding:16px 20px;display:flex;flex-direction:column;gap:10px}
.card-top{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.title{color:#f1f5f9;font-size:1rem;font-weight:bold;text-decoration:none;flex:1;line-height:1.4}.title:hover{color:#f97316}
.flair{background:rgba(249,115,22,.15);border:1px solid #f97316;color:#f97316;font-size:.72rem;padding:2px 8px;border-radius:999px;white-space:nowrap}
.meta{display:flex;flex-wrap:wrap;gap:14px;font-size:.8rem;color:#94a3b8}.meta span strong{color:#fbbf24}
.view-btn{align-self:flex-start;background:transparent;border:1px solid #f97316;color:#f97316;font-size:.78rem;font-family:'Courier New',monospace;padding:5px 14px;border-radius:4px;text-decoration:none;transition:background .15s,color .15s}
.view-btn:hover{background:#f97316;color:#0f172a}
footer{text-align:center;margin-top:48px;font-size:.75rem;color:#334155;letter-spacing:1px}
</style></head><body>
<header><span class="goose">🪿</span>
<div><h1>r/${esc(subreddit)} level search</h1><p>Results for: <strong style="color:#f1f5f9">${esc(query)}</strong></p></div>
<span class="badge">${levels.length} result${levels.length!==1?"s":""}</span></header>
<main>${levels.length===0?`<div style="text-align:center;padding:80px 20px;color:#64748b">🪿 No levels found for "${esc(query)}"</div>`:cards}</main>
<footer>🪿 honk-render-server · r/${esc(subreddit)} level search</footer>
</body></html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/",       (_req, res) => res.json({ status: "ok" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// GET /results?q=...&sub=...
app.get("/results", async (req, res) => {
  const query     = (req.query.q ?? req.query.query ?? "").trim();
  const subreddit = (req.query.sub ?? req.query.subreddit ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  const base      = getBase(req);
  if (!query) return res.status(400).send("<h1>Missing ?q= param</h1>");
  try {
    const levels = await searchLevels(query, 15, subreddit);
    res.setHeader("Content-Type", "text/html");
    return res.send(buildResultsPage(query, levels, base, subreddit));
  } catch (err) {
    return res.status(500).send(`<h1 style="color:red">Error: ${err.message}</h1>`);
  }
});

// GET/POST /search
// Params: query (required), subreddit (default: honk), difficulty (optional), limit (default: 5, max: 15)
// BotGhost reads via {honk.response}
async function handleSearch(req, res) {
  res.status(200);
  res.setHeader("Content-Type", "text/plain");
  let query, subreddit, difficulty, limit, base;
  try {
    query      = getQuery(req);
    subreddit  = getSubreddit();
    difficulty = getDifficulty();
    limit      = getLimit();
    base       = getBase(req);
  } catch(e) {
    return res.send("Error reading request params: " + e.message);
  }
  const start = Date.now();
  log("SEARCH", `"${query}" | r/${subreddit} | difficulty: ${difficulty??"any"} | limit: ${limit}`);
  if (!query) return res.send("No results found — please provide a search query.");
  try {
    let levels   = await searchLevels(query, 50, subreddit);
    levels       = filterByDifficulty(levels, difficulty).slice(0, limit);
    const diffLabel  = difficulty ? ` [${difficulty}]` : "";
    const resultsUrl = `${base}/results?q=${encodeURIComponent(query)}&sub=${encodeURIComponent(subreddit)}`;
    const header     = `${levels.length} result(s) for "${query}" in r/${subreddit}${diffLabel}`;
    log("SEARCH", `Done in ${Date.now()-start}ms — ${levels.length} results`);
    return res.send(formatPosts(header, levels, resultsUrl, limit));
  } catch (err) {
    const timedOut = err.code === "ECONNABORTED";
    const limited  = err.response?.status === 429;
    return res.send(
      timedOut ? "Reddit took too long. Try again in a moment." :
      limited  ? "Too many requests to Reddit. Try again in 30 seconds." :
                 `Search failed: ${err.message}`
    );
  }
}
app.get("/search",   handleSearch);
app.post("/search",  handleSearch);
app.put("/search",   handleSearch);
app.patch("/search", handleSearch);

// GET /image?q=...&sub=...
app.get("/image", async (req, res) => {
  const query     = (req.query.q ?? req.query.query ?? "").trim();
  const subreddit = (req.query.sub ?? req.query.subreddit ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  if (!query) return res.status(400).send("Missing ?q= param");
  try {
    const levels = await searchLevels(query, 1, subreddit);
    if (levels.length === 0) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="220" font-family="sans-serif">
        <rect width="800" height="220" rx="8" fill="#0f172a"/>
        <rect x="0" y="0" width="5" height="220" fill="#f97316"/>
        <text x="400" y="100" fill="#94a3b8" font-size="24" text-anchor="middle">No results found</text>
        <text x="400" y="135" fill="#64748b" font-size="16" text-anchor="middle">Nothing in r/${esc(subreddit)} matching "${esc(query)}"</text>
      </svg>`;
      res.setHeader("Content-Type", "image/png");
      return res.end(svgToPng(svg));
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

// GET /card/:postId/png
app.get("/card/:postId/png", async (req, res) => {
  const { postId } = req.params;
  const subreddit  = getSubreddit();
  const index = parseInt(req.query.index) || 1;
  const total = parseInt(req.query.total) || 1;
  try {
    const level = await getSinglePost(postId, subreddit);
    const png   = svgToPng(renderCard(level, index, total));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(png);
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});

// GET /card/:postId/svg
app.get("/card/:postId/svg", async (req, res) => {
  const { postId } = req.params;
  const subreddit  = getSubreddit();
  const index = parseInt(req.query.index) || 1;
  const total = parseInt(req.query.total) || 1;
  try {
    const level = await getSinglePost(postId, subreddit);
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(renderCard(level, index, total));
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});


// ─── GET /midi?q=... — MIDI file search ──────────────────────────────────────
// Supports both:
//   {option_song}       — plain text e.g. "Shake It Off Taylor Swift"
//   {option_song.title} — BotGhost smart search e.g. "Shake It Off - Taylor Swift"
// Scrapes bitmidi.com → midiworld.com → GitHub (fallback)
// BotGhost reads via {midi.response}
app.get("/midi", async (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/plain");

  const raw = (req.query.q ?? req.query.query ?? req.query.song ?? "").trim();
  if (!raw || /^\{.*\}$/.test(raw)) return res.send("Please provide a song name.");

  // Strip " - " separator from smart search format "Title - Artist" → "Title Artist"
  const query = raw.replace(/\s*-\s*/g, " ").trim();
  const limit = Math.min(parseInt(req.query.limit) || 5, 10);

  log("MIDI", `Searching for "${query}" (raw: "${raw}") limit ${limit}`);

  const result = await searchBitMidi(query, limit)
    || await searchMidiWorld(query, limit)
    || await searchGitHub(query, limit);

  return res.send(result ?? `No MIDI files found for "${raw}". Try a simpler search like just the song title.`);
});

async function searchBitMidi(query, limit) {
  try {
    log("MIDI_BITMIDI", `Trying bitmidi.com for "${query}"`);
    const res = await axios.get("https://bitmidi.com/search", {
      params: { q: query },
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "text/html" },
      timeout: 10_000,
    });
    const html = res.data;
    const matches = [...html.matchAll(/href="(\/[a-z0-9-]+-midi)"/gi)];
    if (!matches.length) return null;
    const seen = new Set();
    const items = [];
    for (const m of matches) {
      const path = m[1];
      if (seen.has(path)) continue;
      seen.add(path);
      const slug = path.replace(/^\//, "").replace(/-midi$/, "");
      items.push({
        name: slug + ".mid",
        downloadUrl: `https://bitmidi.com/uploads/${slug}.mid`,
        pageUrl: `https://bitmidi.com${path}`,
      });
      if (items.length >= limit) break;
    }
    if (!items.length) return null;
    const lines = items.map((it, i) => `${i+1}. ${it.name}\nPage: ${it.pageUrl}\nDownload: ${it.downloadUrl}`);
    const body = `${items.length} MIDI file(s) for "${query}" via bitmidi.com\n\n${lines.join("\n\n")}`;
    log("MIDI_BITMIDI", `Found ${items.length} results`);
    return body.length > 1900 ? body.slice(0, 1880) + "\n...(truncated)" : body;
  } catch (err) {
    log("MIDI_BITMIDI", `Failed: ${err.message}`);
    return null;
  }
}

async function searchMidiWorld(query, limit) {
  try {
    log("MIDI_MIDIWORLD", `Trying midiworld.com for "${query}"`);
    const res = await axios.get("https://www.midiworld.com/search/", {
      params: { q: query },
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "text/html" },
      timeout: 10_000,
    });
    const html = res.data;
    const dlMatches   = [...html.matchAll(/href="(https:\/\/www\.midiworld\.com\/download\/[^"]+)"/gi)];
    const nameMatches = [...html.matchAll(/<a[^>]*href="https:\/\/www\.midiworld\.com\/download\/[^"]*"[^>]*>([^<]+)<\/a>/gi)];
    if (!dlMatches.length) return null;
    const items = dlMatches.slice(0, limit).map((m, i) => ({
      downloadUrl: m[1],
      name: nameMatches[i]?.[1]?.trim() ?? `result-${i+1}.mid`,
    }));
    const lines = items.map((it, i) => `${i+1}. ${it.name}\nDownload: ${it.downloadUrl}`);
    const body = `${items.length} MIDI file(s) for "${query}" via midiworld.com\n\n${lines.join("\n\n")}`;
    log("MIDI_MIDIWORLD", `Found ${items.length} results`);
    return body.length > 1900 ? body.slice(0, 1880) + "\n...(truncated)" : body;
  } catch (err) {
    log("MIDI_MIDIWORLD", `Failed: ${err.message}`);
    return null;
  }
}

async function searchGitHub(query, limit) {
  try {
    log("MIDI_GITHUB", `Trying GitHub for "${query}"`);
    const headers = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "honk-bot-midi/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await axios.get("https://api.github.com/search/code", {
      params: { q: `${query} extension:mid`, per_page: Math.min(limit * 2, 20) },
      headers,
      timeout: 10_000,
    });
    const items = res.data?.items ?? [];
    if (!items.length) return null;
    const results = items.slice(0, limit).map((item, i) => {
      const downloadUrl = item.html_url
        .replace("https://github.com/", "https://raw.githubusercontent.com/")
        .replace("/blob/", "/");
      return `${i+1}. ${item.name}\nRepo: ${item.repository?.full_name ?? "unknown"}\nDownload: ${downloadUrl}`;
    });
    const body = `${results.length} MIDI file(s) for "${query}" via GitHub\n\n${results.join("\n\n")}`;
    log("MIDI_GITHUB", `Found ${results.length} results`);
    return body.length > 1900 ? body.slice(0, 1880) + "\n...(truncated)" : body;
  } catch (err) {
    const limited = err.response?.status === 403 || err.response?.status === 429;
    log("MIDI_GITHUB", `Failed: ${err.message}`);
    if (limited) return "GitHub rate limit hit. Add GITHUB_TOKEN env var on Render to fix.";
    return null;
  }
}


// ─── POST /ai — Honk AI Assistant ────────────────────────────────────────────
// Powered by Aqua API (claude-opus-4-6) with web search + extract tools
// BotGhost reads via {ai.response}
// Env var required: AQUA_API_KEY
//
// BotGhost setup:
//   POST /ai  body: { "message": "{option_question}" }

const AQUA_BASE = "https://api.aquadevs.com";
const HONK_SYSTEM = `You are Honky, a fun and chaotic goose assistant living inside a Discord server for r/honk — a Reddit community that plays a goose-themed level game. You are helpful, witty, and a little unhinged (you're a goose after all). You love honking, chaos, and helping people find cool stuff online.

You have access to web search and can fetch any webpage. Use these freely when you need current information.

Keep responses concise and Discord-friendly — under 1800 characters. Use emojis occasionally. Never be boring. If someone asks about r/honk levels, you know it's a Reddit-based community game with difficulty ratings from Very Easy to Impossible.

HONK. 🪿`;

async function aquaSearch(query) {
  log("AI_SEARCH", `Searching: "${query}"`);
  const res = await axios.post(`${AQUA_BASE}/v1/search`, {
    query,
    depth: "basic",
  }, {
    headers: {
      "Authorization": `Bearer ${process.env.AQUA_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 15_000,
  });
  return res.data?.result?.results ?? [];
}

async function aquaExtract(url) {
  log("AI_EXTRACT", `Extracting: ${url}`);
  const res = await axios.post(`${AQUA_BASE}/v1/extract`, {
    url,
    engine: "quality",
    format: "markdown",
    return_type: "text",
  }, {
    headers: {
      "Authorization": `Bearer ${process.env.AQUA_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 20_000,
  });
  return res.data?.content ?? "";
}

// Tool definitions for claude-opus-4-6
const AI_TOOLS = [
  {
    name: "web_search",
    description: "Search the web for current information, news, facts, or anything you need to look up. Use this freely whenever you need up-to-date info.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_extract",
    description: "Fetch and read the full content of any webpage URL. Use this to get more detail from a search result or any specific page.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
];

async function runAI(message) {
  if (!process.env.AQUA_API_KEY) {
    return "AI assistant not configured — AQUA_API_KEY missing on server.";
  }

  const messages = [{ role: "user", content: message }];
  let finalText = "";
  let iterations = 0;
  const MAX_ITERATIONS = 5; // prevent infinite tool loops

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    log("AI", `Iteration ${iterations} — calling claude-opus-4-6`);

    const res = await axios.post(`${AQUA_BASE}/v1/messages`, {
      model: "claude-opus-4-6",
      max_tokens: 1024,
      system: HONK_SYSTEM,
      tools: AI_TOOLS,
      messages,
    }, {
      headers: {
        "Authorization": `Bearer ${process.env.AQUA_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });

    const data = res.data;
    log("AI", `Stop reason: ${data.stop_reason}`);

    // Add assistant response to message history
    messages.push({ role: "assistant", content: data.content });

    // If done, extract text and return
    if (data.stop_reason === "end_turn") {
      finalText = data.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n")
        .trim();
      break;
    }

    // If tool use, run the tools and feed results back
    if (data.stop_reason === "tool_use") {
      const toolUseBlocks = data.content.filter(b => b.type === "tool_use");
      const toolResults = [];

      for (const tool of toolUseBlocks) {
        log("AI_TOOL", `Using tool: ${tool.name}`, tool.input);
        let toolResult = "";

        try {
          if (tool.name === "web_search") {
            const results = await aquaSearch(tool.input.query);
            toolResult = results.length === 0
              ? "No results found."
              : results.map((r, i) => `${i+1}. ${r.title}\n${r.url}\n${r.content ?? ""}`).join("\n\n");
          } else if (tool.name === "web_extract") {
            const content = await aquaExtract(tool.input.url);
            toolResult = content ? content.slice(0, 3000) : "Could not extract content from that URL.";
          } else {
            toolResult = `Unknown tool: ${tool.name}`;
          }
        } catch (err) {
          toolResult = `Tool error: ${err.message}`;
          log("AI_TOOL_ERROR", `${tool.name} failed: ${err.message}`);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: toolResult,
        });
      }

      // Feed tool results back
      messages.push({ role: "user", content: toolResults });
    }
  }

  if (!finalText) finalText = "Honk... I got confused. Try asking again! 🪿";

  // Hard cap for Discord
  return finalText.length > 1900 ? finalText.slice(0, 1880) + "\n...(honk)" : finalText;
}

app.post("/ai", async (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/plain");

  const message = (req.body?.message ?? req.body?.question ?? req.query?.message ?? "").trim();
  log("AI", `Message: "${message}"`);

  if (!message || /^\{.*\}$/.test(message)) {
    return res.send("Ask me anything! 🪿 e.g. /honk_ai What is the hardest level in r/honk?");
  }

  try {
    const reply = await runAI(message);
    log("AI", `Reply length: ${reply.length} chars`);
    return res.send(reply);
  } catch (err) {
    log("AI_ERROR", `FAILED: ${err.message}`);
    if (err.response?.status === 401) return res.send("Invalid Aqua API key — check AQUA_API_KEY on Render.");
    if (err.response?.status === 429) return res.send("AI rate limited — try again in a moment! 🪿");
    return res.send(`Honk... something went wrong: ${err.message}`);
  }
});

// 404
app.use((req, res) => {
  log("404", `${req.method} ${req.path}`);
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

process.on("uncaughtException",  err => log("UNCAUGHT",  err.message, { stack: err.stack }));
process.on("unhandledRejection", r   => log("UNHANDLED", String(r)));

app.listen(PORT, () => {
  log("STARTUP", `honk-render-server running on port ${PORT}`);
  log("STARTUP", "GET/POST /search  params: query, subreddit, difficulty, limit  → {honk.response}");
  log("STARTUP", "GET      /image?q=...&sub=...   → PNG card");
  log("STARTUP", "GET      /results?q=...&sub=... → HTML page");
  log("STARTUP", "GET      /card/:id/png          → PNG card");
  log("STARTUP", "GET      /card/:id/svg          → SVG debug");
  log("STARTUP", "GET      /midi?q=...&limit=...   → MIDI file search → {midi.response}");
  log("STARTUP", "POST     /ai  { message }          → AI assistant → {ai.response}");
});
