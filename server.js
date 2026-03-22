import express from "express";
import axios from "axios";
import { Resvg } from "@resvg/resvg-js";

const app = express();
const PORT = process.env.PORT || 3847;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  const res = await redditClient.get("/r/honk/search.json", {
    params: { q: query, restrict_sr: 1, sort: "relevance", type: "link", limit: 25, t: "all" },
  });
  return (res.data?.data?.children ?? [])
    .map(c => c.data)
    .filter(p => !p.removed_by_category)
    .slice(0, limit)
    .map(normalisePost);
}

async function getSinglePost(postId) {
  const id = postId.replace(/^t3_/, "");
  const res = await redditClient.get(`/r/honk/comments/${id}.json`, { params: { limit: 1 } });
  const post = res.data?.[0]?.data?.children?.[0]?.data;
  if (!post) throw new Error(`Post ${postId} not found`);
  return normalisePost(post);
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
  const ORANGE = "#f97316", NAVY = "#0f172a", BG2 = "#1e293b";
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
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${NAVY}"/>
      <stop offset="100%" stop-color="#1a2540"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="6" fill="url(#bg)"/>
  <rect x="0" y="0" width="4" height="${H}" fill="${ORANGE}"/>
  <rect x="4" y="0" width="${W-4}" height="2" fill="${ORANGE}" opacity="0.5"/>
  <rect x="${PAD+4}" y="${PAD+4}" width="36" height="22" rx="4" fill="${ORANGE}" opacity="0.15"/>
  <rect x="${PAD+4}" y="${PAD+4}" width="36" height="22" rx="4" stroke="${ORANGE}" stroke-width="1" fill="none"/>
  <text x="${PAD+22}" y="${PAD+19}" fill="${ORANGE}" font-size="11" font-weight="bold" text-anchor="middle">${index}/${total}</text>
  <text x="${PAD+50}" y="${PAD+22}" fill="${TEXT}" font-size="15" font-weight="bold">${title}</text>
  <text x="${PAD+50}" y="${PAD+44}" fill="${MUTED}" font-size="11">
    <tspan fill="${GOLD}" font-weight="bold">u/${author}</tspan>
    <tspan>  ·  r/honk  ·  ${time}</tspan>
  </text>
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
  <rect x="${PAD+200}" y="${H-18}" width="${Math.max(barW, 4)}" height="5" rx="2.5" fill="${barColor}" opacity="0.85"/>
  <text x="${W-PAD-4}" y="${H-13}" fill="${ORANGE}" font-size="9.5" text-anchor="end" opacity="0.8">${esc(trunc(level.url, 55))}</text>
</svg>`;
}

// ─── PNG conversion ───────────────────────────────────────────────────────────
function svgToPng(svg) {
  return new Resvg(svg, { fitTo: { mode: "width", value: 1600 }, font: { loadSystemFonts: false } })
    .render().asPng();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

async function handleSearch(req, res) {
  const query   = (req.body?.query ?? req.query?.q ?? req.query?.query ?? "").trim();
  const limit   = Math.min(parseInt(req.body?.limit ?? req.query?.limit) || 15, 15);
  const baseUrl = process.env.BASE_URL ?? `${req.protocol}://${req.get("host")}`;

  if (!query) return res.status(400).json({ found: false, error: "Missing query" });

  try {
    const levels = await searchLevels(query, limit);
    const payload = {
      query, total: levels.length, found: levels.length > 0,
      summary: levels.length > 0
        ? `Found ${levels.length} result(s) for "${query}" in r/honk`
        : `No levels found for "${query}" in r/honk`,
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
    return res.json(payload);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ found: false, error: err.message });
  }
}

app.post("/level_search", handleSearch);
app.get("/level_search",  handleSearch);

app.get("/card/:postId/png", async (req, res) => {
  try {
    const level = await getSinglePost(req.params.postId);
    const png   = svgToPng(renderCard(level, parseInt(req.query.index)||1, parseInt(req.query.total)||1));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(png);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get("/card/:postId/svg", async (req, res) => {
  try {
    const level = await getSinglePost(req.params.postId);
    const svg   = renderCard(level, parseInt(req.query.index)||1, parseInt(req.query.total)||1);
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(svg);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`honk-render-server running on port ${PORT}`));
