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
  const line = `[${ts}] [${tag}] ${msg}`;
  console.log(line);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// ─── Request logger middleware ────────────────────────────────────────────────
app.use((req, _res, next) => {
  log("REQUEST", `${req.method} ${req.path}`, {
    query: req.query,
    body: req.body,
    ip: req.headers["x-forwarded-for"] ?? req.socket.remoteAddress,
  });
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
    selftext_preview: post.selftext?.slice(0, 200) ?? null,
    image_url: imageUrl,
    subreddit: post.subreddit,
  };
}

async function searchLevels(query, limit = 15) {
  log("REDDIT", `Searching r/honk for "${query}" (limit ${limit})`);
  const start = Date.now();
  try {
    const res = await redditClient.get("/r/honk/search.json", {
      params: { q: query, restrict_sr: 1, sort: "relevance", type: "link", limit: 25, t: "all" },
    });
    const elapsed = Date.now() - start;
    const posts = (res.data?.data?.children ?? [])
      .map(c => c.data)
      .filter(p => !p.removed_by_category)
      .slice(0, limit)
      .map(normalisePost);
    log("REDDIT", `Search complete in ${elapsed}ms — got ${posts.length} results for "${query}"`);
    return posts;
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err.code === "ECONNABORTED" || err.message.includes("timeout")) {
      log("REDDIT_ERROR", `Search TIMED OUT after ${elapsed}ms for "${query}"`);
    } else if (err.response) {
      log("REDDIT_ERROR", `Reddit returned HTTP ${err.response.status} after ${elapsed}ms for "${query}"`, {
        status: err.response.status,
        statusText: err.response.statusText,
      });
    } else {
      log("REDDIT_ERROR", `Search FAILED after ${elapsed}ms for "${query}": ${err.message}`);
    }
    throw err;
  }
}

async function getSinglePost(postId) {
  const id = postId.replace(/^t3_/, "");
  log("REDDIT", `Fetching single post: ${id}`);
  const start = Date.now();
  try {
    const res = await redditClient.get(`/r/honk/comments/${id}.json`, { params: { limit: 1 } });
    const elapsed = Date.now() - start;
    const post = res.data?.[0]?.data?.children?.[0]?.data;
    if (!post) throw new Error(`Post ${id} not found in response`);
    log("REDDIT", `Fetched post "${post.title}" in ${elapsed}ms`);
    return normalisePost(post);
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err.code === "ECONNABORTED" || err.message.includes("timeout")) {
      log("REDDIT_ERROR", `Post fetch TIMED OUT after ${elapsed}ms for post ${id}`);
    } else {
      log("REDDIT_ERROR", `Post fetch FAILED after ${elapsed}ms for post ${id}: ${err.message}`);
    }
    throw err;
  }
}

// ─── SVG Card Renderer ────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function trunc(str, n) { return str?.length > n ? str.slice(0, n-1) + "…" : (str ?? ""); }
function fmtNum(n) { return n >= 1000 ? (n/1000).toFixed(1)+"k" : String(n); }
function relTime(iso) {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d/60000), h = Math.floor(d/3600000), dy = Math.floor(d/86400000);
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (dy < 30) return `${dy}d ago`;
  return `${Math.floor(dy/30)}mo ago`;
}

function renderCard(level, index, total) {
  const W = 800, H = 200, PAD = 20;
  const ORANGE = "#f97316", NAVY = "#0f172a";
  const BORDER = "#334155", TEXT = "#f1f5f9", MUTED = "#94a3b8", GOLD = "#fbbf24";
  const title    = esc(trunc(level.title, 72));
  const author   = esc(level.author);
  const score    = fmtNum(level.score);
  const comments = fmtNum(level.num_comments);
  const time     = relTime(level.created_at);
  const ratio    = Math.round((level.upvote_ratio ?? 0) * 100);
  const barW     = Math.round((W - PAD*2 - 204) * (level.upvote_ratio ?? 0));
  const barColor = ratio >= 95 ? ORANGE : ratio >= 80 ? GOLD : "#86efac";
  const flair    = level.flair ? esc(trunc(level.flair, 28)) : null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Courier New',monospace">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${NAVY}"/><stop offset="100%" stop-color="#1a2540"/></linearGradient></defs>
  <rect width="${W}" height="${H}" rx="6" fill="url(#bg)"/>
  <rect x="0" y="0" width="4" height="${H}" fill="${ORANGE}"/>
  <rect x="4" y="0" width="${W-4}" height="2" fill="${ORANGE}" opacity="0.5"/>
  <rect x="${PAD+4}" y="${PAD+4}" width="36" height="22" rx="4" fill="${ORANGE}" opacity="0.15"/>
  <rect x="${PAD+4}" y="${PAD+4}" width="36" height="22" rx="4" stroke="${ORANGE}" stroke-width="1" fill="none"/>
  <text x="${PAD+22}" y="${PAD+19}" fill="${ORANGE}" font-size="11" font-weight="bold" text-anchor="middle">${index}/${total}</text>
  <text x="${PAD+50}" y="${PAD+22}" fill="${TEXT}" font-size="15" font-weight="bold">${title}</text>
  <text x="${PAD+50}" y="${PAD+44}" fill="${MUTED}" font-size="11"><tspan fill="${GOLD}" font-weight="bold">u/${author}</tspan><tspan>  ·  r/honk  ·  ${time}</tspan></text>
  ${flair ? `<rect x="${PAD+50}" y="${PAD+52}" width="${flair.length*7+16}" height="16" rx="8" fill="${ORANGE}" opacity="0.18"/>
  <rect x="${PAD+50}" y="${PAD+52}" width="${flair.length*7+16}" height="16" rx="8" stroke="${ORANGE}" stroke-width="0.75" fill="none"/>
  <text x="${PAD+58+flair.length*3.5}" y="${PAD+63}" fill="${ORANGE}" font-size="9.5" text-anchor="middle" font-weight="bold">${flair}</text>` : ""}
  <line x1="${PAD+4}" y1="${H-62}" x2="${W-PAD-4}" y2="${H-62}" stroke="${BORDER}" stroke-width="1"/>
  <text x="${PAD+4}" y="${H-42}" fill="${MUTED}" font-size="10">SCORE</text>
  <text x="${PAD+4}" y="${H-26}" fill="${ORANGE}" font-size="15" font-weight="bold">${score}</text>
  <text x="${PAD+80}" y="${H-42}" fill="${MUTED}" font-size="10">COMMENTS</text>
  <text x="${PAD+80}" y="${H-26}" fill="${TEXT}" font-size="15" font-weight="bold">${comments}</text>
  <text x="${PAD+200}" y="${H-42}" fill="${MUTED}" font-size="10">UPVOTE RATIO</text>
  <text x="${PAD+200}" y="${H-26}" fill="${barColor}" font-size="15" font-weight="bold">${ratio}%</text>
  <rect x="${PAD+200}" y="${H-18}" width="${W-PAD*2-204}" height="5" rx="2.5" fill="${BORDER}"/>
  <rect x="${PAD+200}" y="${H-18}" width="${Math.max(barW,4)}" height="5" rx="2.5" fill="${barColor}" opacity="0.85"/>
  <text x="${W-PAD-4}" y="${H-13}" fill="${ORANGE}" font-size="9.5" text-anchor="end" opacity="0.8">${esc(trunc(level.url,55))}</text>
</svg>`;
}

// ─── PNG conversion ───────────────────────────────────────────────────────────
function svgToPng(svg) {
  log("RENDER", "Converting SVG to PNG...");
  const start = Date.now();
  try {
    const png = new Resvg(svg, { fitTo: { mode: "width", value: 1600 }, font: { loadSystemFonts: false } })
      .render().asPng();
    log("RENDER", `PNG conversion done in ${Date.now() - start}ms — ${(png.length/1024).toFixed(1)}KB`);
    return png;
  } catch (err) {
    log("RENDER_ERROR", `PNG conversion FAILED: ${err.message}`);
    throw err;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => { log("HEALTH", "Root health check OK"); res.json({ status: "ok" }); });
app.get("/health", (_req, res) => {
  log("HEALTH", "Health check OK");
  res.json({ status: "ok" });
});

async function handleSearch(req, res) {
  const query   = (req.body?.query ?? req.query?.q ?? req.query?.query ?? "").trim();
  const limit   = Math.min(parseInt(req.body?.limit ?? req.query?.limit) || 15, 15);
  const baseUrl = process.env.BASE_URL ?? `${req.protocol}://${req.get("host")}`;
  const start   = Date.now();

  log("SEARCH", `New search request`, { query, limit, baseUrl });

  if (!query) {
    log("SEARCH_ERROR", "Rejected — missing query param");
    return res.status(400).json({ found: false, error: "Missing query — use ?q=YourSearch" });
  }

  try {
    const levels = await searchLevels(query, limit);

    if (levels.length === 0) {
      log("SEARCH", `No results found for "${query}"`);
      return res.json({ query, total: 0, found: false, summary: `No levels found for "${query}" in r/honk` });
    }

    const payload = {
      query, total: levels.length, found: true,
      summary: `Found ${levels.length} result(s) for "${query}" in r/honk`,
    };

    levels.forEach((level, i) => {
      const p = `r${i}_`;
      payload[`${p}title`]      = level.title;
      payload[`${p}author`]     = level.author;
      payload[`${p}score`]      = level.score;
      payload[`${p}comments`]   = level.num_comments;
      payload[`${p}url`]        = level.url;
      payload[`${p}flair`]      = level.flair ?? "none";
      payload[`${p}time`]       = level.created_at;
      payload[`${p}upvote_pct`] = Math.round((level.upvote_ratio ?? 0) * 100);
      payload[`${p}preview`]    = level.selftext_preview ?? "";
      payload[`${p}id`]         = level.id;
      payload[`${p}index`]      = i + 1;
      payload[`${p}card_url`]   = `${baseUrl}/card/${level.id}/png`;
    });

    log("SEARCH", `Search for "${query}" complete in ${Date.now()-start}ms — returning ${levels.length} results`);
    return res.json(payload);

  } catch (err) {
    const elapsed = Date.now() - start;
    if (err.code === "ECONNABORTED" || err.message.includes("timeout")) {
      log("SEARCH_ERROR", `Search TIMED OUT after ${elapsed}ms — Reddit took too long`);
      return res.status(504).json({ found: false, error: "Reddit request timed out" });
    }
    log("SEARCH_ERROR", `Search FAILED after ${elapsed}ms: ${err.message}`);
    return res.status(500).json({ found: false, error: err.message });
  }
}

app.post("/level_search", handleSearch);
app.get("/level_search",  handleSearch);

app.get("/card/:postId/png", async (req, res) => {
  const { postId } = req.params;
  const index = parseInt(req.query.index) || 1;
  const total = parseInt(req.query.total) || 1;
  const start = Date.now();
  log("CARD_PNG", `Rendering PNG card for post ${postId} (${index}/${total})`);
  try {
    const level = await getSinglePost(postId);
    const svg   = renderCard(level, index, total);
    const png   = svgToPng(svg);
    log("CARD_PNG", `Card for ${postId} ready in ${Date.now()-start}ms`);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(png);
  } catch (err) {
    log("CARD_PNG_ERROR", `Failed to render card for ${postId} after ${Date.now()-start}ms: ${err.message}`);
    return res.status(404).json({ error: err.message });
  }
});

app.get("/card/:postId/svg", async (req, res) => {
  const { postId } = req.params;
  const index = parseInt(req.query.index) || 1;
  const total = parseInt(req.query.total) || 1;
  log("CARD_SVG", `Rendering SVG card for post ${postId}`);
  try {
    const level = await getSinglePost(postId);
    const svg   = renderCard(level, index, total);
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(svg);
  } catch (err) {
    log("CARD_SVG_ERROR", `Failed: ${err.message}`);
    return res.status(404).json({ error: err.message });
  }
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────
app.use((req, res) => {
  log("404", `Unknown route: ${req.method} ${req.path}`);
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Uncaught error handler ───────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  log("UNCAUGHT_EXCEPTION", err.message, { stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  log("UNHANDLED_REJECTION", String(reason));
});

app.listen(PORT, () => {
  log("STARTUP", `honk-render-server running on port ${PORT}`);
  log("STARTUP", "Routes: GET /health | GET+POST /level_search | GET /card/:id/png | GET /card/:id/svg");
});
