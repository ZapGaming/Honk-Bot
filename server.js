import express from "express";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const reddit = axios.create({
  baseURL: "https://www.reddit.com",
  headers: { "User-Agent": "HonkBot/1.0" },
  timeout: 20_000,
});

async function searchLevels(query, limit = 15) {
  const res = await reddit.get("/r/honk/search.json", {
    params: {
      q: query,
      restrict_sr: 1,
      sort: "relevance",  // fuzzy/similar matches not just exact
      t: "all",
      limit: 25,
      raw_json: 1,
    },
  });
  return (res.data?.data?.children ?? [])
    .map(c => c.data)
    .filter(p => !p.removed_by_category)
    .slice(0, limit)
    .map(p => ({
      title:    p.title,
      author:   p.author,
      score:    p.score,
      comments: p.num_comments,
      url:      `https://reddit.com${p.permalink}`,
      flair:    p.link_flair_text ?? null,
      preview:  p.selftext?.slice(0, 150) ?? null,
      ratio:    p.upvote_ratio ?? 0,
    }));
}

function format(query, levels) {
  if (levels.length === 0) return `🪿 No levels found matching **${query}** in r/honk.`;
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
