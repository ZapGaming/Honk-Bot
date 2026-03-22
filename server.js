import express from "express";
import { Resvg } from "@resvg/resvg-js";
import { searchLevels, getSinglePost } from "./reddit.js";
import { renderLevelCard } from "./renderer.js";

const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── SVG → PNG helper ─────────────────────────────────────────────────────────
/**
 * Convert an SVG string to a PNG Buffer using resvg-js.
 * Renders at 2x scale (1600px wide) for crisp Discord embeds.
 */
function svgToPng(svg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1600 }, // 2x the 800px card width
    font: { loadSystemFonts: false },       // faster — we use web-safe fonts
  });
  return resvg.render().asPng(); // returns a Buffer
}

// ─── Base URL helper ──────────────────────────────────────────────────────────
function getBaseUrl(req) {
  return process.env.BASE_URL ?? `${req.protocol}://${req.get("host")}`;
}

// ─── BotGhost payload builder ─────────────────────────────────────────────────
/**
 * Flatten results into BotGhost dot-notation keys.
 * card_url points to /card/:id/png so Discord can display it natively.
 *
 * BotGhost variable names (after naming the block "honk"):
 *   {honk.total}          total results found
 *   {honk.found}          true / false
 *   {honk.r0_title}       title of result 0
 *   {honk.r0_author}      reddit username
 *   {honk.r0_score}       upvote score
 *   {honk.r0_comments}    comment count
 *   {honk.r0_upvote_pct}  e.g. 97
 *   {honk.r0_flair}       post flair or "none"
 *   {honk.r0_url}         full reddit post URL
 *   {honk.r0_card_url}    PNG card image URL for Discord embed image
 *   {honk.r0_preview}     first 200 chars of post body
 */
function buildBotGhostPayload(query, levels, baseUrl) {
  const payload = {
    query,
    total: levels.length,
    found: levels.length > 0,
    summary: levels.length > 0
      ? `Found ${levels.length} level(s) matching "${query}" in r/honk`
      : `No levels found for "${query}" in r/honk`,
  };

  levels.forEach((level, i) => {
    const pfx = `r${i}_`;
    payload[`${pfx}title`]      = level.title;
    payload[`${pfx}author`]     = level.author;
    payload[`${pfx}score`]      = level.score;
    payload[`${pfx}comments`]   = level.num_comments;
    payload[`${pfx}url`]        = level.url;
    payload[`${pfx}flair`]      = level.flair ?? "none";
    payload[`${pfx}time`]       = level.created_at;
    payload[`${pfx}upvote_pct`] = Math.round((level.upvote_ratio ?? 0) * 100);
    payload[`${pfx}preview`]    = level.selftext_preview ?? "";
    payload[`${pfx}id`]         = level.id;
    payload[`${pfx}index`]      = i + 1;
    // PNG card URL — Discord displays this directly in embeds
    payload[`${pfx}card_url`]   = `${baseUrl}/card/${level.id}/png`;
  });

  return payload;
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "honk-render-server", version: "3.0.0" });
});

// ─── POST /level_search  (+ GET alias for browser testing) ───────────────────
async function handleLevelSearch(req, res) {
  const query   = (req.body?.query ?? req.query?.q ?? req.query?.query ?? "").trim();
  const limit   = Math.min(parseInt(req.body?.limit ?? req.query?.limit) || 15, 15);
  const baseUrl = getBaseUrl(req);

  if (!query) {
    return res.status(400).json({
      found: false, total: 0,
      error: "Missing required field: query (POST body) or ?q= (GET param)",
    });
  }

  try {
    const levels  = await searchLevels(query, limit);
    const payload = buildBotGhostPayload(query, levels, baseUrl);
    console.log(`[level_search] "${query}" -> ${levels.length} results`);
    return res.json(payload);
  } catch (err) {
    console.error("[level_search] Error:", err.message);
    return res.status(500).json({ found: false, total: 0, error: err.message });
  }
}

app.post("/level_search", handleLevelSearch);
app.get("/level_search",  handleLevelSearch);

// ─── GET /card/:postId/png ────────────────────────────────────────────────────
// Returns the level card as a PNG image.
// Discord uses this URL directly as the embed image — works in all clients.
//
// Optional query params:
//   ?index=3   which result number to show on the card (default 1)
//   ?total=15  total results in this search (default 1)
app.get("/card/:postId/png", async (req, res) => {
  const { postId } = req.params;
  const index = parseInt(req.query.index) || 1;
  const total = parseInt(req.query.total) || 1;

  try {
    const level = await getSinglePost(postId);
    const svg   = renderLevelCard(level, index, total);
    const png   = svgToPng(svg);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300"); // 5 min cache
    res.setHeader("Content-Length", png.length);
    return res.end(png);
  } catch (err) {
    console.error("[/card/png] Error:", err.message);
    return res.status(404).json({ error: err.message });
  }
});

// ─── GET /card/:postId/svg ────────────────────────────────────────────────────
// Raw SVG — useful for debugging card layout in a browser.
app.get("/card/:postId/svg", async (req, res) => {
  const { postId } = req.params;
  const index = parseInt(req.query.index) || 1;
  const total = parseInt(req.query.total) || 1;

  try {
    const level = await getSinglePost(postId);
    const svg   = renderLevelCard(level, index, total);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(svg);
  } catch (err) {
    console.error("[/card/svg] Error:", err.message);
    return res.status(404).json({ error: err.message });
  }
});

// ─── GET /card/:postId ────────────────────────────────────────────────────────
// JSON with full post data + svg string. For debugging.
app.get("/card/:postId", async (req, res) => {
  const { postId } = req.params;
  const index = parseInt(req.query.index) || 1;
  const total = parseInt(req.query.total) || 1;

  try {
    const level = await getSinglePost(postId);
    const svg   = renderLevelCard(level, index, total);
    return res.json({ ...level, svg });
  } catch (err) {
    console.error("[/card] Error:", err.message);
    return res.status(404).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`honk-render-server v3 running on http://localhost:${PORT}`);
  console.log(`  POST /level_search   { "query": "...", "limit": 15 }`);
  console.log(`  GET  /card/:id/png   PNG card image (use this in Discord embeds)`);
  console.log(`  GET  /card/:id/svg   raw SVG (browser debug)`);
  console.log(`  GET  /health`);
});
