import express from "express";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 3847;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PullPush — free, no API key, no auth required
const pullpush = axios.create({
  baseURL: "https://api.pullpush.io",
  headers: { "User-Agent": "HonkBot/1.0" },
  timeout: 15_000,
});

async function searchLevels(query, limit = 15) {
  const res = await pullpush.get("/reddit/search/submission/", {
    params: {
      q: query,
      subreddit: "honk",
      sort: "desc",
      sort_type: "score",
      size: limit,
    },
  });
  return (res.data?.data ?? []).map(post => ({
    title:    post.title,
    author:   post.author,
    score:    post.score,
    comments: post.num_comments,
    url:      `https://reddit.com${post.permalink}`,
    flair:    post.link_flair_text ?? null,
    preview:  post.selftext?.slice(0, 150) ?? null,
    ratio:    post.upvote_ratio ?? 0,
  }));
}

function format(query, levels) {
  if (levels.length === 0) return `🪿 No levels found for **${query}** in r/honk.`;
  return levels.map((l, i) => [
    `**${i + 1}. ${l.title}**`,
    l.flair   ? `\`${l.flair}\`` : null,
    l.preview ? `> ${l.preview}` : null,
    `⬆ ${l.score}  ·  💬 ${l.comments}  ·  ${Math.round(l.ratio * 100)}% upvoted  ·  u/${l.author}`,
    l.url,
  ].filter(Boolean).join("\n")).join("\n\n");
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/level_search", async (req, res) => {
  const query = (req.body?.query ?? "").trim();
  const limit = Math.min(parseInt(req.body?.limit) || 15, 15);
  console.log(`[POST] query="${query}"`);
  if (!query) return res.json({ response: "❌ Missing query." });
  try {
    const levels = await searchLevels(query, limit);
    return res.json({ response: format(query, levels) });
  } catch (err) {
    console.error(err.message);
    return res.json({ response: `❌ Error: ${err.message}` });
  }
});

// GET for browser testing: /level_search?q=Rollercoaster
app.get("/level_search", async (req, res) => {
  const query = (req.query?.q ?? "").trim();
  const limit = Math.min(parseInt(req.query?.limit) || 15, 15);
  if (!query) return res.json({ response: "❌ Missing ?q= param." });
  try {
    const levels = await searchLevels(query, limit);
    return res.json({ response: format(query, levels) });
  } catch (err) {
    return res.json({ response: `❌ Error: ${err.message}` });
  }
});

app.listen(PORT, () => console.log(`honk-render-server running on port ${PORT}`));
