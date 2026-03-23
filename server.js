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



// ─── GET /devstats?u=username — Developer stat card ──────────────────────────
// Fetches all posts by a user in r/honk, calculates stats, renders a PNG card
// BotGhost reads via {devstats.response} for text, image served at /devstats/png?u=...
app.get("/devstats", async (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/plain");
  const username  = (req.query.u ?? req.query.username ?? "").trim().replace(/^u\//i, "");
  const subreddit = (req.query.sub ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  const base      = getBase(req);
  if (!username) return res.send("Please provide a username e.g. ?u=RecognitionPatient12");
  try {
    const stats = await fetchDevStats(username, subreddit);
    if (stats.totalLevels === 0) return res.send(`No levels found for u/${username} in r/${subreddit}.`);
    const cardUrl = `${base}/devstats/png?u=${encodeURIComponent(username)}&sub=${encodeURIComponent(subreddit)}`;
    return res.send([
      `u/${username} — r/${subreddit} Dev Stats`,
      `Levels: ${stats.totalLevels} | Total Score: ${fmtNum(stats.totalScore)} | Avg Score: ${fmtNum(Math.round(stats.avgScore))}`,
      `Comments: ${fmtNum(stats.totalComments)} | Avg Ratio: ${stats.avgRatio}%`,
      `Best Level: ${trunc(stats.bestLevel.title, 50)} (⬆${stats.bestLevel.score})`,
      `Active since ${stats.activeSince} · Last post ${stats.latestPost}`,
      `Card: ${cardUrl}`,
    ].join("\n"));
  } catch (err) {
    log("DEVSTATS_ERROR", err.message);
    return res.send(`Error fetching stats: ${err.message}`);
  }
});

// GET /devstats/png?u=username — renders the full stat card as PNG
app.get("/devstats/png", async (req, res) => {
  const username  = (req.query.u ?? req.query.username ?? "").trim().replace(/^u\//i, "");
  const subreddit = (req.query.sub ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  log("DEVSTATS_PNG", `Rendering card for u/${username} in r/${subreddit}`);
  if (!username) return res.status(400).json({ error: "Missing ?u= param" });
  try {
    const stats = await fetchDevStats(username, subreddit);
    const svg   = renderDevStatsCard(stats, subreddit);
    const png   = svgToPng(svg);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(png);
  } catch (err) {
    log("DEVSTATS_PNG_ERROR", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Fetch and calculate all dev stats ────────────────────────────────────────
async function fetchDevStats(username, subreddit = "honk") {
  log("DEVSTATS", `Fetching stats for u/${username} in r/${subreddit}`);
  const start = Date.now();

  const res = await redditClient.get(`/r/${subreddit}/search.json`, {
    params: { q: `author:${username}`, restrict_sr: 1, sort: "top", type: "link", limit: 100, t: "all" },
  });

  const posts = (res.data?.data?.children ?? [])
    .map(c => c.data)
    .filter(p => !p.removed_by_category)
    .map(normalisePost);

  log("DEVSTATS", `Got ${posts.length} posts in ${Date.now()-start}ms`);

  if (posts.length === 0) return { totalLevels: 0 };

  const totalScore    = posts.reduce((s, p) => s + p.score, 0);
  const totalComments = posts.reduce((s, p) => s + p.num_comments, 0);
  const avgScore      = totalScore / posts.length;
  const avgRatio      = Math.round(posts.reduce((s, p) => s + (p.upvote_ratio ?? 0), 0) / posts.length * 100);
  const bestLevel     = posts.reduce((b, p) => p.score > b.score ? p : b, posts[0]);

  // Sort by date to get first and latest
  const sorted    = [...posts].sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  const activeSince = new Date(sorted[0].created_at).toLocaleDateString("en-US", { month:"short", year:"numeric" });
  const latestPost  = relTime(sorted[sorted.length-1].created_at);

  // Top 3 by score
  const top3 = [...posts].sort((a,b) => b.score - a.score).slice(0, 3);

  // Difficulty breakdown
  const diffMap = {};
  for (const p of posts) {
    const f = p.flair ?? "None";
    diffMap[f] = (diffMap[f] ?? 0) + 1;
  }
  const diffBreakdown = Object.entries(diffMap)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => {
      const colors = {
        "🍰 VERY EASY":"#86efac","🟢 EASY":"#4ade80","🟡 MEDIUM":"#fbbf24",
        "🔴 HARD":"#f97316","🔥 INSANE":"#ef4444",
        "💀🔥 NEAR IMPOSSIBLE":"#a855f7","🔥💀🔥 IMPOSSIBLE":"#ec4899",
      };
      return { label: label.slice(0, 8), full: label, count, color: colors[label] ?? "#94a3b8" };
    });

  const topDifficulty = diffBreakdown[0]?.full ?? "None";

  return {
    username, subreddit, totalLevels: posts.length,
    totalScore, avgScore, totalComments, avgRatio,
    bestLevel, activeSince, latestPost, top3, diffBreakdown, topDifficulty,
  };
}

// ── Render the stat card SVG ──────────────────────────────────────────────────
function renderDevStatsCard(stats, subreddit = "honk") {
  const W=1000, H=420, PAD=32;
  const ORANGE="#f97316", NAVY="#0f172a", BG2="#1e293b", BORDER="#334155";
  const TEXT="#f1f5f9", MUTED="#94a3b8", GOLD="#fbbf24", GREEN="#86efac";

  function statBox(x, y, w, h, label, value, sub, accent) {
    return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${BG2}"/>
  <rect x="${x}" y="${y}" width="3" height="${h}" rx="1.5" fill="${accent}"/>
  <text x="${x+16}" y="${y+22}" fill="${MUTED}" font-size="10" letter-spacing="1">${esc(label)}</text>
  <text x="${x+16}" y="${y+50}" fill="${TEXT}" font-size="22" font-weight="bold">${esc(String(value))}</text>
  ${sub ? `<text x="${x+16}" y="${y+68}" fill="${MUTED}" font-size="10">${esc(sub)}</text>` : ""}`;
  }

  const top3SVG = stats.top3.map((l, i) => {
    const y = PAD + 248 + i * 30;
    const medals = ["🥇","🥈","🥉"];
    const barW = Math.round((l.score / Math.max(stats.top3[0].score, 1)) * 420);
    return `
  <rect x="${PAD+8}" y="${y-16}" width="430" height="24" rx="4" fill="${BG2}" opacity="0.6"/>
  <rect x="${PAD+8}" y="${y-16}" width="${Math.max(barW,4)}" height="24" rx="4" fill="${ORANGE}" opacity="0.2"/>
  <text x="${PAD+16}" y="${y+3}" fill="${TEXT}" font-size="12">${medals[i]} ${esc(trunc(l.title, 42))}</text>
  <text x="${PAD+446}" y="${y+3}" fill="${GOLD}" font-size="12" font-weight="bold" text-anchor="end">⬆ ${fmtNum(l.score)}</text>`;
  }).join("");

  const maxDiffCount = Math.max(...stats.diffBreakdown.map(d => d.count), 1);
  const diffSVG = stats.diffBreakdown.map((d, i) => {
    const x  = PAD + 530 + i * 90;
    const y  = PAD + 248;
    const bH = Math.max(Math.round((d.count / maxDiffCount) * 60), 4);
    return `
  <rect x="${x}" y="${y+(60-bH)}" width="64" height="${bH}" rx="4" fill="${d.color}" opacity="0.85"/>
  <text x="${x+32}" y="${y+76}" fill="${MUTED}" font-size="9" text-anchor="middle">${esc(d.label)}</text>
  <text x="${x+32}" y="${y+90}" fill="${TEXT}" font-size="12" font-weight="bold" text-anchor="middle">${d.count}</text>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${NAVY}"/><stop offset="100%" stop-color="#1a2540"/></linearGradient>
    <linearGradient id="stripe" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${ORANGE}"/><stop offset="100%" stop-color="#fb923c"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="10" fill="url(#bg)"/>
  <rect x="0" y="0" width="6" height="${H}" rx="3" fill="url(#stripe)"/>
  <rect x="6" y="0" width="${W-6}" height="3" fill="${ORANGE}" opacity="0.4"/>

  <text x="${PAD+8}" y="${PAD+22}" fill="${ORANGE}" font-size="11" letter-spacing="2">r/${esc(subreddit)}</text>
  <text x="${PAD+8}" y="${PAD+56}" fill="${TEXT}" font-size="26" font-weight="bold">🪿 u/${esc(stats.username)}</text>
  <text x="${PAD+8}" y="${PAD+78}" fill="${MUTED}" font-size="12">Active since ${esc(stats.activeSince)}  ·  Last post ${esc(stats.latestPost)}  ·  ${stats.totalLevels} levels  ·  ${esc(stats.topDifficulty)}</text>

  <line x1="${PAD}" y1="${PAD+96}" x2="${W-PAD}" y2="${PAD+96}" stroke="${BORDER}" stroke-width="1"/>

  ${statBox(PAD,     PAD+110, 172, 82, "TOTAL SCORE",    fmtNum(stats.totalScore),                  "combined upvotes",  ORANGE)}
  ${statBox(PAD+188, PAD+110, 172, 82, "AVG SCORE",      fmtNum(Math.round(stats.avgScore)),        "per level",         GOLD)}
  ${statBox(PAD+376, PAD+110, 172, 82, "TOTAL LEVELS",   stats.totalLevels,                         "posts on r/honk",   GREEN)}
  ${statBox(PAD+564, PAD+110, 172, 82, "TOTAL COMMENTS", fmtNum(stats.totalComments),               "received",          "#a78bfa")}
  ${statBox(PAD+752, PAD+110, 172, 82, "AVG RATIO",      stats.avgRatio+"%",                        "upvote ratio",      "#f472b6")}

  <line x1="${PAD}" y1="${PAD+206}" x2="${W-PAD}" y2="${PAD+206}" stroke="${BORDER}" stroke-width="1" opacity="0.5"/>

  <text x="${PAD+8}"   y="${PAD+228}" fill="${MUTED}" font-size="10" letter-spacing="1">TOP LEVELS</text>
  ${top3SVG}

  <text x="${PAD+530}" y="${PAD+228}" fill="${MUTED}" font-size="10" letter-spacing="1">DIFFICULTY BREAKDOWN</text>
  ${diffSVG}

  <rect x="${W-PAD-230}" y="${PAD+8}" width="230" height="52" rx="8" fill="${BG2}"/>
  <rect x="${W-PAD-230}" y="${PAD+8}" width="3"   height="52" rx="1.5" fill="${GOLD}"/>
  <text x="${W-PAD-220}" y="${PAD+26}" fill="${MUTED}" font-size="10" letter-spacing="1">BEST LEVEL</text>
  <text x="${W-PAD-220}" y="${PAD+44}" fill="${GOLD}" font-size="13" font-weight="bold">${esc(trunc(stats.bestLevel.title, 22))}</text>
  <text x="${W-PAD-8}"   y="${PAD+44}" fill="${ORANGE}" font-size="13" font-weight="bold" text-anchor="end">⬆ ${fmtNum(stats.bestLevel.score)}</text>
</svg>`;
}

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
  log("STARTUP", "GET      /devstats?u=...&sub=...   → Dev stats text → {devstats.response}");
  log("STARTUP", "GET      /devstats/png?u=...        → Dev stats PNG card");
});
