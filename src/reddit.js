import axios from "axios";

const REDDIT_BASE = "https://www.reddit.com";
const SUBREDDIT = "honk";

// Reddit's public search API — no auth needed, no API key required.
// Uses the JSON endpoint that Reddit exposes on all pages.
const redditClient = axios.create({
  baseURL: REDDIT_BASE,
  headers: {
    // Reddit blocks default axios UA, spoof a browser-like one
    "User-Agent":
      "Mozilla/5.0 (compatible; HonkBot/1.0; Discord level search)",
    Accept: "application/json",
  },
  timeout: 10_000,
});

/**
 * Normalise a raw Reddit post (from the .data field) into our level schema.
 * @param {object} post  Raw Reddit post .data object
 * @returns {LevelPost}
 */
function normalisePost(post) {
  const thumbnail =
    post.thumbnail &&
    post.thumbnail !== "self" &&
    post.thumbnail !== "default" &&
    post.thumbnail !== "nsfw" &&
    post.thumbnail !== ""
      ? post.thumbnail
      : null;

  // r/honk posts often embed an image — try to pull the best one
  let imageUrl = thumbnail;
  if (post.preview?.images?.[0]?.source?.url) {
    // Reddit HTML-encodes preview URLs
    imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, "&");
  }

  return {
    id: post.id,
    title: post.title,
    author: post.author,
    score: post.score,
    upvote_ratio: post.upvote_ratio,
    num_comments: post.num_comments,
    created_utc: post.created_utc,
    // ISO string for easy display
    created_at: new Date(post.created_utc * 1000).toISOString(),
    url: `https://reddit.com${post.permalink}`,
    permalink: post.permalink,
    flair: post.link_flair_text ?? null,
    selftext_preview:
      post.selftext?.slice(0, 200) ?? null,
    image_url: imageUrl,
    is_video: post.is_video ?? false,
    domain: post.domain,
    subreddit: post.subreddit,
  };
}

/**
 * Search r/honk for posts matching `query`. Returns up to `limit` results.
 * Uses Reddit's /r/honk/search.json endpoint (no OAuth required).
 *
 * @param {string} query
 * @param {number} limit  max 15 (enforced by caller)
 * @returns {Promise<LevelPost[]>}
 */
export async function searchLevels(query, limit = 15) {
  const params = {
    q: query,
    restrict_sr: 1,       // restrict to r/honk only
    sort: "relevance",
    type: "link",
    limit: Math.min(limit, 25), // fetch a few extra in case some are deleted
    t: "all",
  };

  const response = await redditClient.get(
    `/r/${SUBREDDIT}/search.json`,
    { params }
  );

  const posts = response.data?.data?.children ?? [];

  return posts
    .map((child) => child.data)
    .filter((post) => !post.removed_by_category) // skip removed posts
    .slice(0, limit)
    .map(normalisePost);
}

/**
 * Fetch a single post by its Reddit post ID (t3_xxxxx or just xxxxx).
 * @param {string} postId
 * @returns {Promise<LevelPost>}
 */
export async function getSinglePost(postId) {
  const id = postId.replace(/^t3_/, ""); // strip prefix if present
  const response = await redditClient.get(
    `/r/${SUBREDDIT}/comments/${id}.json`,
    { params: { limit: 1 } }
  );

  const postData = response.data?.[0]?.data?.children?.[0]?.data;
  if (!postData) {
    throw new Error(`Post ${postId} not found in r/${SUBREDDIT}`);
  }

  return normalisePost(postData);
}

/**
 * @typedef {Object} LevelPost
 * @property {string}  id
 * @property {string}  title
 * @property {string}  author
 * @property {number}  score
 * @property {number}  upvote_ratio
 * @property {number}  num_comments
 * @property {number}  created_utc
 * @property {string}  created_at
 * @property {string}  url
 * @property {string}  permalink
 * @property {string|null} flair
 * @property {string|null} selftext_preview
 * @property {string|null} image_url
 * @property {boolean} is_video
 * @property {string}  domain
 * @property {string}  subreddit
 */
