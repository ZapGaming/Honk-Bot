import express from "express";
import axios from "axios";
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

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
  "🍰 VERY EASY","🟢 EASY","🟡 MEDIUM","🔴 HARD",
  "🔥 INSANE","💀🔥 NEAR IMPOSSIBLE","🔥💀🔥 IMPOSSIBLE",
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
  const raw = parseInt(req.body?.limit ?? req.query?.limit);
  if (!raw || isNaN(raw)) return 5;
  return Math.min(Math.max(raw, 1), 15);
}
function getDifficulty(req) {
  const raw = (req.body?.difficulty ?? req.query?.difficulty ?? "").trim();
  if (!raw) return null;
  return DIFFICULTIES.find(d => d.toLowerCase() === raw.toLowerCase()) ?? null;
}
function getBase(req) {
  return process.env.BASE_URL ?? `https://${req.get("host")}`;
}

// ─── Reddit helpers ───────────────────────────────────────────────────────────
function normalisePost(post) {
  let imageUrl = null;
  if (post.thumbnail && !["self","default","nsfw",""].includes(post.thumbnail)) imageUrl = post.thumbnail;
  if (post.preview?.images?.[0]?.source?.url) imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, "&");
  return {
    id: post.id, title: post.title, author: post.author,
    score: post.score, upvote_ratio: post.upvote_ratio ?? 0,
    num_comments: post.num_comments,
    created_at: new Date(post.created_utc * 1000).toISOString(),
    url: `https://reddit.com${post.permalink}`,
    flair: post.link_flair_text ?? null,
    selftext_preview: post.selftext?.slice(0, 150) ?? null,
    image_url: imageUrl,
    subreddit: post.subreddit ?? "honk",
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
    const posts = (res.data?.data?.children ?? []).map(c => c.data).filter(p => !p.removed_by_category).map(normalisePost);
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
    const res = await redditClient.get(`/r/${subreddit}/comments/${id}.json`, { params: { limit: 1 } });
    const post = res.data?.[0]?.data?.children?.[0]?.data;
    if (!post) throw new Error(`Post ${id} not found`);
    log("REDDIT", `Fetched "${post.title}" in ${Date.now()-start}ms`);
    return normalisePost(post);
  } catch (err) {
    log("REDDIT_ERROR", `FAILED after ${Date.now()-start}ms: ${err.message}`);
    throw err;
  }
}

// ─── Text helpers ─────────────────────────────────────────────────────────────
function esc(s)    { return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function trunc(s,n){ return s?.length>n ? s.slice(0,n-1)+"…":(s??""); }
function fmtNum(n) { return n>=1000?(n/1000).toFixed(1)+"k":String(n); }
function relTime(iso) {
  const d=Date.now()-new Date(iso).getTime(),m=Math.floor(d/60000),h=Math.floor(d/3600000),dy=Math.floor(d/86400000);
  if(m<60)return `${m}m ago`;if(h<24)return `${h}h ago`;if(dy<30)return `${dy}d ago`;return `${Math.floor(dy/30)}mo ago`;
}
// Strip emoji — resvg cannot render them
function noEmoji(s) {
  return String(s ?? "")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ").trim();
}

// ─── Response formatter ───────────────────────────────────────────────────────
function formatPosts(header, posts, resultsUrl, limit) {
  const warning = limit > 5 ? "\n Warning: more than 5 results — may be cut off." : "";
  if (posts.length === 0) return `${header}${warning}\nNo results found.\n${resultsUrl}`;
  const lines = posts.map((l, i) => {
    const flair = l.flair && l.flair !== "none" ? ` [${noEmoji(l.flair)}]` : "";
    return `${i+1}. ${noEmoji(trunc(l.title, 55))}${flair}\nu/${l.author} | ^${fmtNum(l.score)} | c:${fmtNum(l.num_comments)} | ${relTime(l.created_at)}\n${l.url}`;
  });
  const body = `${header}${warning}\n${resultsUrl}\n\n${lines.join("\n\n")}`;
  return body.length > 1900 ? body.slice(0, 1880) + "\n...(truncated)" : body;
}

// ─── SVG → PNG ────────────────────────────────────────────────────────────────
function svgToPng(svg) {
  const start = Date.now();
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: 1600 },
    font: { loadSystemFonts: true },
  }).render().asPng();
  log("RENDER", `PNG done in ${Date.now()-start}ms — ${(png.length/1024).toFixed(1)}KB`);
  return png;
}

// ─── Level card — modern frosted glass ───────────────────────────────────────
function renderCard(level, index, total) {
  const W=800, H=220;
  const title  = esc(noEmoji(trunc(level.title, 65)));
  const author = esc(noEmoji(level.author));
  const sub    = esc(noEmoji(level.subreddit ?? "honk"));
  const flair  = level.flair && level.flair !== "none" ? esc(noEmoji(trunc(level.flair, 28))) : null;
  const flairW = flair ? Math.min(flair.length * 7 + 24, 180) : 0;
  const ratio  = Math.round((level.upvote_ratio ?? 0) * 100);
  const barW   = Math.round(480 * (level.upvote_ratio ?? 0));
  const barColor = ratio >= 95 ? "#86efac" : ratio >= 80 ? "#fbbf24" : "#f97316";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0f1e"/><stop offset="100%" stop-color="#0f1f3d"/></linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.08"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0.02"/></linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#f97316"/><stop offset="100%" stop-color="#fb923c" stop-opacity="0"/></linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#f97316"/><stop offset="100%" stop-color="#fbbf24"/></linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="150" cy="110" rx="140" ry="80" fill="#f97316" opacity="0.07" filter="url(#blur)"/>
  <ellipse cx="650" cy="60" rx="100" ry="60" fill="#6366f1" opacity="0.06" filter="url(#blur)"/>
  <rect x="12" y="12" width="776" height="196" rx="16" fill="url(#glass)"/>
  <rect x="12" y="12" width="776" height="196" rx="16" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <rect x="12" y="12" width="776" height="1" fill="rgba(255,255,255,0.2)"/>
  <rect x="12" y="12" width="4" height="196" rx="2" fill="url(#glow)"/>
  <rect x="32" y="32" width="52" height="26" rx="13" fill="rgba(249,115,22,0.15)" stroke="rgba(249,115,22,0.4)" stroke-width="1"/>
  <text x="58" y="50" fill="#f97316" font-size="11" font-weight="600" text-anchor="middle">${index} / ${total}</text>
  <rect x="716" y="32" width="60" height="26" rx="13" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <text x="746" y="50" fill="rgba(255,255,255,0.5)" font-size="10" text-anchor="middle">r/${sub}</text>
  <text x="100" y="58" fill="#f8fafc" font-size="16" font-weight="700">${title}</text>
  <text x="100" y="82" fill="rgba(255,255,255,0.45)" font-size="12">
    <tspan fill="#fbbf24" font-weight="600">u/${author}</tspan>
    <tspan>  ·  ${relTime(level.created_at)}</tspan>
  </text>
  ${flair ? `<rect x="100" y="94" width="${flairW}" height="18" rx="9" fill="rgba(249,115,22,0.15)" stroke="rgba(249,115,22,0.35)" stroke-width="1"/>
  <text x="${100 + flairW/2}" y="107" fill="#f97316" font-size="10" font-weight="600" text-anchor="middle">${flair}</text>` : ""}
  <line x1="28" y1="130" x2="772" y2="130" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  <text x="40"  y="152" fill="rgba(255,255,255,0.35)" font-size="9" letter-spacing="1.5">SCORE</text>
  <text x="40"  y="175" fill="#f97316" font-size="20" font-weight="700">${fmtNum(level.score)}</text>
  <text x="130" y="152" fill="rgba(255,255,255,0.35)" font-size="9" letter-spacing="1.5">COMMENTS</text>
  <text x="130" y="175" fill="#f8fafc" font-size="20" font-weight="700">${fmtNum(level.num_comments)}</text>
  <text x="260" y="152" fill="rgba(255,255,255,0.35)" font-size="9" letter-spacing="1.5">UPVOTE RATIO</text>
  <text x="260" y="175" fill="${barColor}" font-size="20" font-weight="700">${ratio}%</text>
  <rect x="260" y="184" width="480" height="4" rx="2" fill="rgba(255,255,255,0.08)"/>
  <rect x="260" y="184" width="${Math.max(barW,4)}" height="4" rx="2" fill="url(#bar)"/>
  <text x="772" y="204" fill="rgba(249,115,22,0.4)" font-size="9" text-anchor="end">${esc(trunc(level.url,55))}</text>
</svg>`;
}

// ─── Dev stats card — modern frosted glass ────────────────────────────────────
function renderDevStatsCard(stats, subreddit) {
  const W=1000, H=420;
  const maxDiff = Math.max(...stats.diffBreakdown.map(d => d.count), 1);

  const top3SVG = stats.top3.map((l, i) => {
    const y = 278 + i*38;
    const medals = ["#1","#2","#3"];
    const bw = Math.round((l.score / Math.max(stats.top3[0].score,1)) * 400);
    return `<rect x="40" y="${y-18}" width="440" height="28" rx="6" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  <rect x="40" y="${y-18}" width="${Math.max(bw,4)}" height="28" rx="6" fill="rgba(249,115,22,0.12)"/>
  <text x="52" y="${y+5}" fill="#f8fafc" font-size="13">${medals[i]} ${esc(noEmoji(trunc(l.title,40)))}</text>
  <text x="468" y="${y+5}" fill="#fbbf24" font-size="13" font-weight="700" text-anchor="end">^ ${fmtNum(l.score)}</text>`;
  }).join("");

  const diffSVG = stats.diffBreakdown.map((d, i) => {
    const x = 540 + i*88, y = 278;
    const bH = Math.max(Math.round((d.count/maxDiff)*60), 4);
    return `<rect x="${x}" y="${y+(60-bH)}" width="68" height="${bH}" rx="4" fill="${d.color}" opacity="0.8"/>
  <rect x="${x}" y="${y+(60-bH)}" width="68" height="${bH}" rx="4" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
  <text x="${x+34}" y="${y+78}" fill="rgba(255,255,255,0.4)" font-size="9" text-anchor="middle">${esc(noEmoji(d.label))}</text>
  <text x="${x+34}" y="${y+94}" fill="#f8fafc" font-size="13" font-weight="700" text-anchor="middle">${d.count}</text>`;
  }).join("");

  const statBox = (x,y,w,label,value,sub,accent) => `
  <rect x="${x}" y="${y}" width="${w}" height="86" rx="12" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <rect x="${x}" y="${y}" width="${w}" height="1" fill="rgba(255,255,255,0.15)"/>
  <rect x="${x}" y="${y}" width="3" height="86" rx="1.5" fill="${accent}"/>
  <text x="${x+18}" y="${y+24}" fill="rgba(255,255,255,0.35)" font-size="9" letter-spacing="1.5">${label}</text>
  <text x="${x+18}" y="${y+56}" fill="#f8fafc" font-size="22" font-weight="700">${value}</text>
  ${sub ? `<text x="${x+18}" y="${y+74}" fill="rgba(255,255,255,0.3)" font-size="10">${sub}</text>` : ""}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#080d1a"/><stop offset="100%" stop-color="#0d1b35"/></linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#f97316"/><stop offset="100%" stop-color="#f97316" stop-opacity="0"/></linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="30"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="200" cy="150" rx="200" ry="120" fill="#f97316" opacity="0.06" filter="url(#blur)"/>
  <ellipse cx="800" cy="80" rx="150" ry="100" fill="#6366f1" opacity="0.05" filter="url(#blur)"/>
  <ellipse cx="700" cy="350" rx="120" ry="80" fill="#06b6d4" opacity="0.04" filter="url(#blur)"/>
  <rect x="16" y="16" width="968" height="388" rx="20" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <rect x="16" y="16" width="968" height="1" fill="rgba(255,255,255,0.18)"/>
  <rect x="16" y="16" width="5" height="388" rx="2.5" fill="url(#glow)"/>
  <text x="40" y="56" fill="rgba(249,115,22,0.7)" font-size="11" letter-spacing="2">r/${esc(noEmoji(subreddit))}</text>
  <text x="40" y="92" fill="#f8fafc" font-size="28" font-weight="800">u/${esc(noEmoji(stats.username))}</text>
  <text x="40" y="116" fill="rgba(255,255,255,0.35)" font-size="12">Active since ${esc(stats.activeSince)}  ·  Last post ${esc(stats.latestPost)}  ·  ${stats.totalLevels} levels  ·  Top: ${esc(noEmoji(stats.topDifficulty))}</text>
  <rect x="720" y="28" width="248" height="58" rx="12" fill="rgba(255,255,255,0.04)" stroke="rgba(251,191,36,0.3)" stroke-width="1"/>
  <rect x="720" y="28" width="248" height="1" fill="rgba(255,255,255,0.15)"/>
  <rect x="720" y="28" width="3" height="58" rx="1.5" fill="#fbbf24"/>
  <text x="734" y="48" fill="rgba(255,255,255,0.35)" font-size="9" letter-spacing="1.5">BEST LEVEL</text>
  <text x="734" y="68" fill="#fbbf24" font-size="13" font-weight="700">${esc(noEmoji(trunc(stats.bestLevel.title,22)))}</text>
  <text x="960" y="68" fill="#f97316" font-size="13" font-weight="700" text-anchor="end">^ ${fmtNum(stats.bestLevel.score)}</text>
  <line x1="28" y1="136" x2="972" y2="136" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  ${statBox(28,  150, 178, "TOTAL SCORE",    fmtNum(stats.totalScore),           "combined upvotes", "#f97316")}
  ${statBox(214, 150, 178, "AVG SCORE",      fmtNum(Math.round(stats.avgScore)), "per level",        "#fbbf24")}
  ${statBox(400, 150, 178, "TOTAL LEVELS",   stats.totalLevels,                  "posts on r/honk",  "#86efac")}
  ${statBox(586, 150, 178, "TOTAL COMMENTS", fmtNum(stats.totalComments),        "received",         "#a78bfa")}
  ${statBox(772, 150, 178, "AVG RATIO",      stats.avgRatio+"%",                 "upvote ratio",     "#f472b6")}
  <line x1="28" y1="252" x2="972" y2="252" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <text x="40"  y="272" fill="rgba(255,255,255,0.3)" font-size="9" letter-spacing="1.5">TOP LEVELS</text>
  <text x="540" y="272" fill="rgba(255,255,255,0.3)" font-size="9" letter-spacing="1.5">DIFFICULTY BREAKDOWN</text>
  ${top3SVG}
  ${diffSVG}
</svg>`;
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
        <div class="card-top"><a href="${esc(l.url)}" target="_blank" class="title">${esc(l.title)}</a>${flair}</div>
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

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>r/${esc(subreddit)} — ${esc(query)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#f1f5f9;font-family:'Courier New',monospace;padding-bottom:60px}
header{background:#1e293b;border-bottom:2px solid #f97316;padding:24px 32px;display:flex;align-items:center;gap:16px}
header h1{font-size:1.4rem;color:#f97316;letter-spacing:1px}
header p{font-size:.85rem;color:#94a3b8;margin-top:4px}
.badge{margin-left:auto;background:#f97316;color:#0f172a;font-weight:bold;font-size:.8rem;padding:4px 12px;border-radius:999px}
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
.view-btn{align-self:flex-start;background:transparent;border:1px solid #f97316;color:#f97316;font-size:.78rem;font-family:'Courier New',monospace;padding:5px 14px;border-radius:4px;text-decoration:none;transition:background .15s,color .15s}
.view-btn:hover{background:#f97316;color:#0f172a}
footer{text-align:center;margin-top:48px;font-size:.75rem;color:#334155;letter-spacing:1px}
</style></head><body>
<header>
  <div><h1>🪿 r/${esc(subreddit)} level search</h1><p>Results for: <strong style="color:#f1f5f9">${esc(query)}</strong></p></div>
  <span class="badge">${levels.length} result${levels.length!==1?"s":""}</span>
</header>
<main>${levels.length===0?`<div style="text-align:center;padding:80px 20px;color:#64748b">No levels found for "${esc(query)}"</div>`:cards}</main>
<footer>🪿 honk-render-server · r/${esc(subreddit)} level search</footer>
</body></html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/",       (_req, res) => res.json({ status: "ok" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// GET /results
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

// GET/POST /search — BotGhost reads via {honk.response}
async function handleSearch(req, res) {
  res.status(200);
  res.setHeader("Content-Type", "text/plain");
  const query      = getQuery(req);
  const subreddit  = getSubreddit(req);
  const difficulty = getDifficulty(req);
  const limit      = getLimit(req);
  const base       = getBase(req);
  const start      = Date.now();
  log("SEARCH", `"${query}" | r/${subreddit} | diff:${difficulty??"any"} | limit:${limit}`);
  if (!query) return res.send("Please provide a search query.");
  try {
    let levels   = await searchLevels(query, 50, subreddit);
    levels       = filterByDifficulty(levels, difficulty).slice(0, limit);
    const diffLabel  = difficulty ? ` [${noEmoji(difficulty)}]` : "";
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

// GET /image
app.get("/image", async (req, res) => {
  const query     = (req.query.q ?? req.query.query ?? "").trim();
  const subreddit = (req.query.sub ?? req.query.subreddit ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  if (!query) return res.status(400).send("Missing ?q= param");
  try {
    const levels = await searchLevels(query, 1, subreddit);
    if (levels.length === 0) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="220" font-family="sans-serif">
        <rect width="800" height="220" rx="8" fill="#0a0f1e"/>
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
    return res.status(500).json({ error: err.message });
  }
});

// GET /card/:postId/png
app.get("/card/:postId/png", async (req, res) => {
  const { postId } = req.params;
  const subreddit  = getSubreddit(req);
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
  const subreddit  = getSubreddit(req);
  try {
    const level = await getSinglePost(postId, subreddit);
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(renderCard(level, parseInt(req.query.index)||1, parseInt(req.query.total)||1));
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});

// GET /devstats?u=username
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
      `Best: ${noEmoji(trunc(stats.bestLevel.title, 50))} (^${stats.bestLevel.score})`,
      `Active since ${stats.activeSince} · Last post ${stats.latestPost}`,
      `Card: ${cardUrl}`,
    ].join("\n"));
  } catch (err) {
    return res.send(`Error: ${err.message}`);
  }
});

// GET /devstats/png
app.get("/devstats/png", async (req, res) => {
  const username  = (req.query.u ?? req.query.username ?? "").trim().replace(/^u\//i, "");
  const subreddit = (req.query.sub ?? "honk").trim().replace(/^r\//i,"").replace(/[^a-zA-Z0-9_]/g,"") || "honk";
  if (!username) return res.status(400).json({ error: "Missing ?u= param" });
  try {
    const stats = await fetchDevStats(username, subreddit);
    const png   = svgToPng(renderDevStatsCard(stats, subreddit));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(png);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function fetchDevStats(username, subreddit = "honk") {
  log("DEVSTATS", `Fetching stats for u/${username} in r/${subreddit}`);
  const res = await redditClient.get(`/r/${subreddit}/search.json`, {
    params: { q: `author:${username}`, restrict_sr: 1, sort: "top", type: "link", limit: 100, t: "all" },
  });
  const posts = (res.data?.data?.children ?? []).map(c => c.data).filter(p => !p.removed_by_category).map(normalisePost);
  if (posts.length === 0) return { totalLevels: 0 };
  const totalScore    = posts.reduce((s,p) => s + p.score, 0);
  const totalComments = posts.reduce((s,p) => s + p.num_comments, 0);
  const avgScore      = totalScore / posts.length;
  const avgRatio      = Math.round(posts.reduce((s,p) => s + (p.upvote_ratio??0), 0) / posts.length * 100);
  const bestLevel     = posts.reduce((b,p) => p.score > b.score ? p : b, posts[0]);
  const sorted        = [...posts].sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  const activeSince   = new Date(sorted[0].created_at).toLocaleDateString("en-US",{month:"short",year:"numeric"});
  const latestPost    = relTime(sorted[sorted.length-1].created_at);
  const top3          = [...posts].sort((a,b) => b.score-a.score).slice(0,3);
  const diffMap       = {};
  for (const p of posts) { const f = p.flair ?? "None"; diffMap[f] = (diffMap[f]??0)+1; }
  const DIFF_COLORS   = {
    "🍰 VERY EASY":"#86efac","🟢 EASY":"#4ade80","🟡 MEDIUM":"#fbbf24",
    "🔴 HARD":"#f97316","🔥 INSANE":"#ef4444","💀🔥 NEAR IMPOSSIBLE":"#a855f7","🔥💀🔥 IMPOSSIBLE":"#ec4899",
  };
  const diffBreakdown = Object.entries(diffMap).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([label,count]) => ({
    label: noEmoji(label).slice(0,8), full: label, count, color: DIFF_COLORS[label] ?? "#94a3b8",
  }));
  return { username, subreddit, totalLevels:posts.length, totalScore, avgScore, totalComments, avgRatio, bestLevel, activeSince, latestPost, top3, diffBreakdown, topDifficulty: diffBreakdown[0]?.full ?? "None" };
}

// MIDI search
app.get("/midi", async (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/plain");
  const raw = (req.query.q ?? req.query.query ?? req.query.song ?? "").trim();
  if (!raw || /^\{.*\}$/.test(raw)) return res.send("Please provide a song name.");
  const query = raw.replace(/\s*-\s*/g, " ").trim();
  const limit = Math.min(parseInt(req.query.limit) || 5, 10);
  log("MIDI", `Searching for "${query}" limit ${limit}`);
  const result = await searchBitMidi(query, limit) || await searchMidiWorld(query, limit) || await searchGitHub(query, limit);
  return res.send(result ?? `No MIDI files found for "${raw}". Try a simpler search.`);
});

async function searchBitMidi(query, limit) {
  try {
    const res = await axios.get("https://bitmidi.com/search", {
      params: { q: query },
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "text/html" },
      timeout: 10_000,
    });
    const matches = [...res.data.matchAll(/href="(\/[a-z0-9-]+-midi)"/gi)];
    if (!matches.length) return null;
    const seen = new Set();
    const items = [];
    for (const m of matches) {
      const path = m[1];
      if (seen.has(path)) continue;
      seen.add(path);
      const slug = path.replace(/^\//, "").replace(/-midi$/, "");
      items.push({ name: slug+".mid", downloadUrl: `https://bitmidi.com/uploads/${slug}.mid`, pageUrl: `https://bitmidi.com${path}` });
      if (items.length >= limit) break;
    }
    if (!items.length) return null;
    const lines = items.map((it,i) => `${i+1}. ${it.name}\nPage: ${it.pageUrl}\nDownload: ${it.downloadUrl}`);
    const body = `${items.length} MIDI file(s) for "${query}" via bitmidi.com\n\n${lines.join("\n\n")}`;
    return body.length > 1900 ? body.slice(0,1880)+"\n...(truncated)" : body;
  } catch { return null; }
}

async function searchMidiWorld(query, limit) {
  try {
    const res = await axios.get("https://www.midiworld.com/search/", {
      params: { q: query },
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "text/html" },
      timeout: 10_000,
    });
    const dlMatches   = [...res.data.matchAll(/href="(https:\/\/www\.midiworld\.com\/download\/[^"]+)"/gi)];
    const nameMatches = [...res.data.matchAll(/<a[^>]*href="https:\/\/www\.midiworld\.com\/download\/[^"]*"[^>]*>([^<]+)<\/a>/gi)];
    if (!dlMatches.length) return null;
    const items = dlMatches.slice(0,limit).map((m,i) => ({ downloadUrl: m[1], name: nameMatches[i]?.[1]?.trim() ?? `result-${i+1}.mid` }));
    const lines = items.map((it,i) => `${i+1}. ${it.name}\nDownload: ${it.downloadUrl}`);
    const body = `${items.length} MIDI file(s) for "${query}" via midiworld.com\n\n${lines.join("\n\n")}`;
    return body.length > 1900 ? body.slice(0,1880)+"\n...(truncated)" : body;
  } catch { return null; }
}

async function searchGitHub(query, limit) {
  try {
    const headers = { "Accept": "application/vnd.github+json", "User-Agent": "honk-bot-midi/1.0", "X-GitHub-Api-Version": "2022-11-28" };
    if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await axios.get("https://api.github.com/search/code", {
      params: { q: `${query} extension:mid`, per_page: Math.min(limit*2,20) },
      headers, timeout: 10_000,
    });
    const items = res.data?.items ?? [];
    if (!items.length) return null;
    const results = items.slice(0,limit).map((item,i) => {
      const dl = item.html_url.replace("https://github.com/","https://raw.githubusercontent.com/").replace("/blob/","/");
      return `${i+1}. ${item.name}\nRepo: ${item.repository?.full_name??"unknown"}\nDownload: ${dl}`;
    });
    const body = `${results.length} MIDI file(s) for "${query}" via GitHub\n\n${results.join("\n\n")}`;
    return body.length > 1900 ? body.slice(0,1880)+"\n...(truncated)" : body;
  } catch (err) {
    const limited = err.response?.status === 403 || err.response?.status === 429;
    if (limited) return "GitHub rate limit hit. Add GITHUB_TOKEN env var on Render to fix.";
    return null;
  }
}


// ─── AI Chat ──────────────────────────────────────────────────────────────────
// Public API service — each bot owner sends their own credentials
// POST /ai/chat
// Body: {
//   message:     string   — the user's message (required)
//   user_id:     string   — Discord user ID for history scoping
//   username:    string   — Discord username for display
//   channel_id:  string   — Discord channel ID
//   api_key:     string   — Aqua API key (required)
//   model:       string   — model name e.g. claude-opus-4-6 (required)
//   mongo_uri:   string   — MongoDB connection string (required)
//   system:      string   — optional system prompt override
// }
// Returns plain text → {ai.response}

import { MongoClient } from "mongodb";

// Cache MongoDB clients per URI so we don't reconnect on every request
const mongoClients = new Map();
async function getMongoClient(uri) {
  if (mongoClients.has(uri)) return mongoClients.get(uri);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  mongoClients.set(uri, client);
  log("MONGO", "Connected to MongoDB");
  return client;
}

async function getHistory(mongoUri, userId, channelId, limit = 20) {
  try {
    const client = await getMongoClient(mongoUri);
    const db     = client.db("honkbot");
    const col    = db.collection("chat_history");
    const docs   = await col
      .find({ user_id: userId, channel_id: channelId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    // Reverse so oldest first for the AI
    return docs.reverse().map(d => ({ role: d.role, content: d.content }));
  } catch (err) {
    log("MONGO_ERROR", `Failed to get history: ${err.message}`);
    return [];
  }
}

async function saveMessage(mongoUri, userId, channelId, role, content) {
  try {
    const client = await getMongoClient(mongoUri);
    const db     = client.db("honkbot");
    const col    = db.collection("chat_history");
    await col.insertOne({ user_id: userId, channel_id: channelId, role, content, timestamp: new Date() });
  } catch (err) {
    log("MONGO_ERROR", `Failed to save message: ${err.message}`);
  }
}

async function clearHistory(mongoUri, userId, channelId) {
  try {
    const client = await getMongoClient(mongoUri);
    const db     = client.db("honkbot");
    const col    = db.collection("chat_history");
    const result = await col.deleteMany({ user_id: userId, channel_id: channelId });
    return result.deletedCount;
  } catch (err) {
    log("MONGO_ERROR", `Failed to clear history: ${err.message}`);
    return 0;
  }
}

app.post("/ai/chat", async (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/plain");

  const {
    message, user_id, username, channel_id,
    api_key, model, mongo_uri, system,
    api_endpoint,
  } = req.body ?? {};

  log("AI_CHAT", `u/${username} (${user_id}) in ${channel_id}: "${String(message).slice(0,80)}"`);

  // Validate required fields
  if (!message)   return res.send("Error: missing message field.");
  if (!api_key)   return res.send("Error: missing api_key field.");
  if (!model)     return res.send("Error: missing model field.");
  if (!mongo_uri) return res.send("Error: missing mongo_uri field.");

  const uid = String(user_id  ?? "unknown");
  const cid = String(channel_id ?? "unknown");
  const uname = String(username ?? "unknown");

  // Handle clear command
  if (String(message).trim().toLowerCase() === "!clear") {
    const n = await clearHistory(mongo_uri, uid, cid);
    return res.send(`Cleared ${n} messages from chat history.`);
  }

  try {
    // 1. Fetch history from MongoDB
    const history = await getHistory(mongo_uri, uid, cid, 20);
    log("AI_CHAT", `Loaded ${history.length} history messages`);

    // 2. Save user message to MongoDB
    await saveMessage(mongo_uri, uid, cid, "user", String(message));

    // 3. Build messages array with history + new message
    const messages = [
      ...history,
      { role: "user", content: String(message) },
    ];

    // 4. Default system prompt — vanilla helpful assistant
    const systemPrompt = system
      ? String(system)
      : `You are a helpful AI assistant. The user's Discord username is ${uname}. Be concise, friendly, and keep responses under 1800 characters for Discord.`;

    // 5. Call AI API
    const baseUrl = (api_endpoint ?? "https://api.aquadevs.com").replace(/\/+$/, "");
    log("AI_CHAT", `Using endpoint: ${baseUrl}`);
    const aiRes = await axios.post(`${baseUrl}/v1/messages`, {
      model:      String(model),
      max_tokens: 1024,
      system:     systemPrompt,
      messages,
    }, {
      headers: {
        "Authorization": `Bearer ${api_key}`,
        "Content-Type":  "application/json",
      },
      timeout: 30_000,
    });

    // 6. Extract response text
    const reply = (aiRes.data?.content ?? [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();

    if (!reply) return res.send("The AI returned an empty response. Try again.");

    // 7. Save AI reply to MongoDB
    await saveMessage(mongo_uri, uid, cid, "assistant", reply);

    log("AI_CHAT", `Reply (${reply.length} chars) saved to MongoDB`);

    // 8. Return — hard cap for Discord
    return res.send(reply.length > 1900 ? reply.slice(0, 1880) + "\n...(truncated)" : reply);

  } catch (err) {
    log("AI_CHAT_ERROR", `FAILED: ${err.message}`);
    if (err.response?.status === 401) return res.send("Invalid API key.");
    if (err.response?.status === 429) return res.send("AI rate limited. Try again in a moment.");
    if (err.response?.status === 400) return res.send(`Bad request to AI API: ${err.response?.data?.error?.message ?? err.message}`);
    return res.send(`AI error: ${err.message}`);
  }
});

// GET /ai/clear?user_id=...&channel_id=...&mongo_uri=...
app.get("/ai/clear", async (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/plain");
  const { user_id, channel_id, mongo_uri } = req.query;
  if (!mongo_uri)   return res.send("Missing mongo_uri param.");
  if (!user_id)     return res.send("Missing user_id param.");
  if (!channel_id)  return res.send("Missing channel_id param.");
  const n = await clearHistory(mongo_uri, user_id, channel_id);
  return res.send(`Cleared ${n} messages from chat history. Fresh start!`);
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
  log("STARTUP", "GET/POST /search  → {honk.response}");
  log("STARTUP", "GET      /devstats?u=...  → {devstats.response}");
  log("STARTUP", "GET      /devstats/png?u=...  → PNG stat card");
  log("STARTUP", "GET      /midi?q=...  → {midi.response}");
  log("STARTUP", "GET      /image?q=...  → PNG level card");
  log("STARTUP", "GET      /results?q=...  → HTML page");
  log("STARTUP", "GET      /card/:id/png");
  log("STARTUP", "GET      /card/:id/svg");
  log("STARTUP", "POST     /ai/chat  { message, user_id, channel_id, api_key, model, mongo_uri }");
  log("STARTUP", "GET      /ai/clear?user_id=...&channel_id=...&mongo_uri=...");
});
