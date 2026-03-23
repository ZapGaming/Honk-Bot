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
    query: req.query,
    body:  req.body,
    ip:    req.headers["x-forwarded-for"] ?? req.socket.remoteAddress,
    ua:    req.headers["user-agent"],
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
  "🍰 VERY EASY",
  "🟢 EASY",
  "🟡 MEDIUM",
  "🔴 HARD",
  "🔥 INSANE",
  "💀🔥 NEAR IMPOSSIBLE",
  "🔥💀🔥 IMPOSSIBLE",
];

// ─── Param helpers ────────────────────────────────────────────────────────────
function getQuery(req) {
  return (req.body?.query ?? req.body?.q ?? req.query?.q ?? req.query?.query ?? "").trim();
}

function getSubreddit(req) {
  const raw = (req.body?.subreddit ?? req.query?.subreddit ?? req.body?.sub ?? req.query?.sub ?? "honk").trim();
  return raw.replace(/^r\//i, "").replace(/[^a-zA-Z0-9_]/g, "") || "honk";
}

function getLimit(req) {
  return Math.min(parseInt(req.body?.limit ?? req.query?.limit) || 15, 15);
}

function getDifficulty(req) {
  const raw = (req.body?.difficulty ?? req.query?.difficulty ?? "").trim();
  if (!raw) return null;
  return DIFFICULTIES.find(d => d.toLowerCase() === raw.toLowerCase()) ?? null;
}

function getBase(req) {
  return process.env.BASE_URL ?? `https://${req.get("host")}`;
}

// ─── Reddit ───────────────────────────────────────────────────────────────────
function normalisePost(post) {
  let imageUrl = null;
  if (post.thumbnail && !["self","default","nsfw",""].includes(post.thumbnail)) imageUrl = post.thumbnail;
  if (post.preview?.images?.[0]?.source?.url) imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, "&");
  return {
    id:               post.id,
    title:            post.title,
    author:           post.author,
    score:            post.score,
    upvote_ratio:     post.upvote_ratio ?? 0,
    num_comments:     post.num_comments,
    created_at:       new Date(post.created_utc * 1000).toISOString(),
    url:              `https://reddit.com${post.permalink}`,
    flair:            post.link_flair_text ?? null,
    selftext_preview: post.selftext?.slice(0, 150) ?? null,
    image_url:        imageUrl,
    subreddit:        post.subreddit ?? "honk",
  };
}

function filterByDifficulty(posts, difficulty) {
  if (!difficulty) return posts;
  return posts.filter(p => (p.flair ?? "").toLowerCase().trim() === difficulty.toLowerCase().trim());
}

async function searchLevels(query, limit = 15, subreddit = "honk") {
  log("REDDIT", `Searching r/${subreddit} for "${query}" limit ${limit}`);
  const start = Date.now();
  try {
    const res = await redditClient.get(`/r/${subreddit}/search.json`, {
      params: { q: query, restrict_sr: 1, sort: "relevance", type: "link", limit: 50, t: "all" },
    });
    const posts = (res.data?.data?.children ?? [])
      .map(c => c.data)
      .filter(p => !p.removed_by_category)
      .map(normalisePost);
    log("REDDIT", `Got ${posts.length} results in ${Date.now()-start}ms`);
    return posts;
  } catch (err) {
    const ms = Date.now() - start;
    if (err.code === "ECONNABORTED")       log("REDDIT_ERROR", `TIMED OUT after ${ms}ms`);
    else if (err.response?.status === 429) log("REDDIT_ERROR", `RATE LIMITED (429) after ${ms}ms`);
    else if (err.response)                 log("REDDIT_ERROR", `HTTP ${err.response.status} after ${ms}ms`);
    else                                   log("REDDIT_ERROR", `FAILED after ${ms}ms: ${err.message}`);
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

// ─── Shared response formatter — plain text BotGhost reads via {xxx.response} ─
function formatPosts(header, posts, resultsUrl) {
  if (posts.length === 0) {
    return `${header}\nNo results found.\n${resultsUrl}`;
  }
  const lines = posts.map((l, i) => {
    const flair = l.flair && l.flair !== "none" ? ` [${l.flair}]` : "";
    return `${i+1}. ${l.title}${flair}\nby u/${l.author} | Score: ${fmtNum(l.score)} | Comments: ${fmtNum(l.num_comments)} | ${relTime(l.created_at)}\n${l.url}`;
  });
  return `${header}\nFull results: ${resultsUrl}\n---\n${lines.join("\n\n")}`;
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
  <text x="${PAD+58}" y="${PAD+42}" font-size="12" fill="${MUTED}"><tspan fill="${GOLD}" font-weight="bold">u/${esc(level.author)}</tspan><tspan fill="${MUTED}">  ·  ${relTime(level.created_at)}</tspan></text>
  ${flair ? `<rect x="${PAD+58}" y="${PAD+54}" width="${flairW}" height="18" rx="9" fill="${ORANGE}" opacity="0.15"/>
  <rect x="${PAD+58}" y="${PAD+54}" width="${flairW}" height="18" rx="9" stroke="${ORANGE}" stroke-width="0.8" fill="none"/>
  <text x="${PAD+58+flairW/2}" y="${PAD+67}" fill="${ORANGE}" font-size="10" font-weight="bold" text-anchor="middle">${flair}</text>` : ""}
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
  log("RENDER", "Converting SVG → PNG");
  const start = Date.now();
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1600 }, font: { loadSystemFonts: true } }).render().asPng();
  log("RENDER", `PNG done in ${Date.now()-start}ms — ${(png.length/1024).toFixed(1)}KB`);
  return png;
}

// ─── Results HTML page ────────────────────────────────────────────────────────
function buildResultsPage(query, levels, base, subreddit) {
  const cards = levels.map(l => {
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
  <title>r/${esc(subreddit)} — "${esc(query)}"</title>
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
      <h1>r/${esc(subreddit)} level search</h1>
      <p>Results for: <strong style="color:#f1f5f9">${esc(query)}</strong></p>
    </div>
    <span class="badge">${levels.length} result${levels.length!==1?"s":""}</span>
  </header>
  <main>${levels.length===0
    ? `<div style="text-align:center;padding:80px 20px;color:#64748b">🪿 No levels found for "${esc(query)}"</div>`
    : cards
  }</main>
  <footer>🪿 honk-render-server · r/${esc(subreddit)} level search</footer>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/",       (_req, res) => res.json({ status: "ok" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// GET /results?q=...&sub=... — HTML results page
app.get("/results", async (req, res) => {
  const query     = (req.query.q ?? req.query.query ?? "").trim();
  const subreddit = (req.query.sub ?? req.query.subreddit ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  const base      = getBase(req);
  log("RESULTS_PAGE", `"${query}" in r/${subreddit}`);
  if (!query) return res.status(400).send("<h1>Missing ?q= param</h1>");
  try {
    const levels = await searchLevels(query, 15, subreddit);
    res.setHeader("Content-Type", "text/html");
    return res.send(buildResultsPage(query, levels, base, subreddit));
  } catch (err) {
    log("RESULTS_PAGE_ERROR", err.message);
    return res.status(500).send(`<h1 style="color:red">Error: ${err.message}</h1>`);
  }
});

// GET /search?q=...&difficulty=...&sub=...&limit=...
// POST /search body: { query, difficulty, subreddit, limit }
// BotGhost reads response via {honk.response}
async function handleSearch(req, res) {
  const query      = getQuery(req);
  const subreddit  = getSubreddit(req);
  const difficulty = getDifficulty(req);
  const limit      = getLimit(req);
  const base       = getBase(req);
  const start      = Date.now();

  log("SEARCH", `"${query}" | sub: r/${subreddit} | difficulty: ${difficulty ?? "any"} | limit: ${limit}`);

  if (!query) {
    log("SEARCH_ERROR", "Missing query");
    return res.status(400).send("No results found — missing query.");
  }

  try {
    let levels = await searchLevels(query, 50, subreddit);
    levels     = filterByDifficulty(levels, difficulty).slice(0, limit);

    const diffLabel  = difficulty ? ` [${difficulty}]` : "";
    const resultsUrl = `${base}/results?q=${encodeURIComponent(query)}&sub=${encodeURIComponent(subreddit)}`;
    const header     = `${levels.length} result(s) for "${query}" in r/${subreddit}${diffLabel}`;

    log("SEARCH", `Done in ${Date.now()-start}ms — ${levels.length} results`);
    return res.send(formatPosts(header, levels, resultsUrl));

  } catch (err) {
    const ms       = Date.now() - start;
    const timedOut = err.code === "ECONNABORTED";
    const limited  = err.response?.status === 429;
    log("SEARCH_ERROR", `${timedOut?"TIMEOUT":limited?"RATE_LIMITED":"FAILED"} after ${ms}ms: ${err.message}`);
    return res.send(
      timedOut ? "Reddit took too long to respond. Try again in a moment." :
      limited  ? "Too many requests to Reddit. Try again in 30 seconds." :
                 `Search failed: ${err.message}`
    );
  }
}
app.get("/search",  handleSearch);
app.post("/search", handleSearch);

// GET /user?u=username&difficulty=...&sub=...
// BotGhost reads response via {user.response}
app.get("/user", async (req, res) => {
  const username   = (req.query.u ?? req.query.username ?? "").trim().replace(/^u\//i, "");
  const subreddit  = getSubreddit(req);
  const difficulty = getDifficulty(req);
  const base       = getBase(req);
  const start      = Date.now();

  log("USER", `u/${username} in r/${subreddit} | difficulty: ${difficulty ?? "any"}`);
  if (!username) return res.status(400).send("Missing ?u= param (reddit username)");

  try {
    let levels = await searchLevels(`author:${username}`, 50, subreddit);
    levels     = filterByDifficulty(levels, difficulty).slice(0, 15);

    const diffLabel  = difficulty ? ` [${difficulty}]` : "";
    const resultsUrl = `${base}/results?q=${encodeURIComponent(`author:${username}`)}&sub=${encodeURIComponent(subreddit)}`;
    const header     = `${levels.length} level(s) by u/${username} in r/${subreddit}${diffLabel}`;

    log("USER", `Done in ${Date.now()-start}ms — ${levels.length} results`);
    return res.send(formatPosts(header, levels, resultsUrl));

  } catch (err) {
    log("USER_ERROR", `FAILED: ${err.message}`);
    return res.send(`Error fetching levels: ${err.message}`);
  }
});

// GET /top?timeframe=week&difficulty=...&sub=...
// BotGhost reads response via {top.response}
app.get("/top", async (req, res) => {
  const rawTime    = (req.query.timeframe ?? req.body?.timeframe ?? "all").toLowerCase().trim();
  const subreddit  = getSubreddit(req);
  const difficulty = getDifficulty(req);
  const base       = getBase(req);
  const start      = Date.now();
  const timeMap    = { today:"day", day:"day", week:"week", "this week":"week", month:"month", "this month":"month", year:"year", all:"all", "all time":"all" };
  const t          = timeMap[rawTime] ?? "all";
  const timeLabel  = { day:"Today", week:"This Week", month:"This Month", year:"This Year", all:"All Time" }[t];

  log("TOP", `r/${subreddit} | t=${t} | difficulty: ${difficulty ?? "any"}`);

  try {
    const res2 = await redditClient.get(`/r/${subreddit}/top.json`, { params: { t, limit: 50 } });
    let levels = (res2.data?.data?.children ?? [])
      .map(c => c.data)
      .filter(p => !p.removed_by_category)
      .map(normalisePost);
    levels     = filterByDifficulty(levels, difficulty).slice(0, 15);

    const diffLabel  = difficulty ? ` [${difficulty}]` : "";
    const resultsUrl = `${base}/results?q=top&sub=${encodeURIComponent(subreddit)}`;
    const header     = `Top ${levels.length} level(s) in r/${subreddit} — ${timeLabel}${diffLabel}`;

    log("TOP", `Done in ${Date.now()-start}ms — ${levels.length} results`);
    return res.send(formatPosts(header, levels, resultsUrl));

  } catch (err) {
    log("TOP_ERROR", `FAILED: ${err.message}`);
    return res.send(`Error fetching top levels: ${err.message}`);
  }
});

// GET /image?q=...&sub=... — first result PNG card for Discord embed image field
app.get("/image", async (req, res) => {
  const query     = (req.query.q ?? req.query.query ?? "").trim();
  const subreddit = (req.query.sub ?? req.query.subreddit ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  log("IMAGE", `"${query}" in r/${subreddit}`);
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
  const subreddit  = getSubreddit(req);
  const index      = parseInt(req.query.index) || 1;
  const total      = parseInt(req.query.total) || 1;
  log("CARD", `PNG for ${postId} (${index}/${total})`);
  try {
    const level = await getSinglePost(postId, subreddit);
    const png   = svgToPng(renderCard(level, index, total));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(png);
  } catch (err) {
    log("CARD_ERROR", `Failed for ${postId}: ${err.message}`);
    return res.status(404).json({ error: err.message });
  }
});

// GET /card/:postId/svg
app.get("/card/:postId/svg", async (req, res) => {
  const { postId } = req.params;
  const subreddit  = getSubreddit(req);
  const index      = parseInt(req.query.index) || 1;
  const total      = parseInt(req.query.total) || 1;
  log("CARD_SVG", `SVG for ${postId}`);
  try {
    const level = await getSinglePost(postId, subreddit);
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(renderCard(level, index, total));
  } catch (err) {
    log("CARD_SVG_ERROR", `Failed: ${err.message}`);
    return res.status(404).json({ error: err.message });
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
  log("STARTUP", "GET/POST /search?q=...&difficulty=...&sub=...&limit=...  → {honk.response}");
  log("STARTUP", "GET      /user?u=...&difficulty=...&sub=...              → {user.response}");
  log("STARTUP", "GET      /top?timeframe=...&difficulty=...&sub=...       → {top.response}");
  log("STARTUP", "GET      /image?q=...&sub=...                            → PNG card");
  log("STARTUP", "GET      /results?q=...&sub=...                          → HTML page");
  log("STARTUP", "GET      /card/:id/png                                   → PNG card");
  log("STARTUP", "GET      /card/:id/svg                                   → SVG debug");
});
