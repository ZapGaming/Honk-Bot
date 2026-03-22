import express from "express";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 3847;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const reddit = axios.create({
  baseURL: "https://www.reddit.com",
  headers: { "User-Agent": "Mozilla/5.0 (compatible; HonkBot/1.0)" },
  timeout: 10_000,
});

function normalise(post) {
  return {
    title:        post.title,
    author:       post.author,
    score:        post.score,
    upvote_ratio: post.upvote_ratio,
    num_comments: post.num_comments,
    url:          `https://reddit.com${post.permalink}`,
    flair:        post.link_flair_text ?? null,
    preview:      post.selftext?.slice(0, 150) ?? null,
  };
}

async function searchLevels(query, limit = 15) {
  const res = await reddit.get("/r/honk/search.json", {
    params: { q: query, restrict_sr: 1, sort: "relevance", type: "link", limit: 25, t: "all" },
  });
  return (res.data?.data?.children ?? [])
    .map(c => c.data)
    .filter(p => !p.removed_by_category)
    .slice(0, limit)
    .map(normalise);
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/level_search", async (req, res) => {
  const query = (req.body?.query ?? "").trim();
  const limit = Math.min(parseInt(req.body?.limit) || 15, 15);

  if (!query) {
    return res.json({ response: "❌ Missing query." });
  }

  try {
    const levels = await searchLevels(query, limit);

    if (levels.length === 0) {
      return res.json({ response: `🪿 No levels found for **${query}** in r/honk.` });
    }

    // Build one formatted string BotGhost uses as {honk.response}
    const lines = levels.map((l, i) => {
      const parts = [
        `**${i + 1}. ${l.title}**`,
        l.flair ? `\`${l.flair}\`` : null,
        l.preview ? `> ${l.preview}` : null,
        `⬆ ${l.score}  ·  💬 ${l.num_comments}  ·  ${Math.round((l.upvote_ratio ?? 0) * 100)}% upvoted  ·  u/${l.author}`,
        l.url,
      ].filter(Boolean);
      return parts.join("\n");
    });

    return res.json({ response: lines.join("\n\n") });

  } catch (err) {
    console.error(err.message);
    return res.json({ response: `❌ Error: ${err.message}` });
  }
});

app.listen(PORT, () => console.log(`honk-render-server running on port ${PORT}`));
