/**
 * renderer.js
 * Generates styled SVG cards for r/honk level posts.
 * Each card is designed to look great as a Discord embed (800×200px).
 *
 * Aesthetic: dark retro-arcade / goose-punk — deep navy bg, orange/amber
 * accents, pixel-flavoured geometric borders, clean tabular data layout.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeXml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function relativeTime(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (mins < 60)   return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  if (days < 30)   return `${days}d ago`;
  if (months < 12) return `${months}mo ago`;
  return `${years}y ago`;
}

function formatScore(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// Colour ramp for upvote ratio bar
function ratioColor(ratio) {
  if (ratio >= 0.95) return "#f97316"; // hot orange
  if (ratio >= 0.80) return "#fbbf24"; // amber
  if (ratio >= 0.60) return "#86efac"; // soft green
  return "#94a3b8";                    // muted
}

// Subtle noise-pattern background as inline SVG filter
const NOISE_FILTER = `
  <filter id="noise" x="0%" y="0%" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3"
      stitchTiles="stitch" result="noiseOut"/>
    <feColorMatrix type="saturate" values="0" in="noiseOut" result="grayNoise"/>
    <feBlend in="SourceGraphic" in2="grayNoise" mode="overlay" result="blended"/>
    <feComposite in="blended" in2="SourceGraphic" operator="in"/>
  </filter>
`;

// ─── Card dimensions ─────────────────────────────────────────────────────────
const W = 800;
const H = 200;
const PAD = 20;
const ACCENT = "#f97316";    // orange
const BG     = "#0f172a";    // deep navy
const BG2    = "#1e293b";    // card surface
const BORDER = "#334155";    // subtle border
const TEXT   = "#f1f5f9";    // primary text
const MUTED  = "#94a3b8";    // secondary text
const GOOSE  = "#fbbf24";    // goose yellow

// ─── Goose emoji SVG (simple geometric) ──────────────────────────────────────
// A tiny pixel-art style goose head as inline SVG group
function gooseIcon(x, y, size = 28) {
  return `
    <g transform="translate(${x}, ${y})">
      <!-- body -->
      <ellipse cx="${size * 0.5}" cy="${size * 0.62}" rx="${size * 0.38}" ry="${size * 0.3}"
        fill="${GOOSE}" opacity="0.9"/>
      <!-- neck -->
      <rect x="${size * 0.38}" y="${size * 0.25}" width="${size * 0.16}" height="${size * 0.32}"
        rx="4" fill="${GOOSE}" opacity="0.9"/>
      <!-- head -->
      <ellipse cx="${size * 0.46}" cy="${size * 0.22}" rx="${size * 0.16}" ry="${size * 0.13}"
        fill="${GOOSE}" opacity="0.9"/>
      <!-- eye -->
      <circle cx="${size * 0.5}" cy="${size * 0.19}" r="${size * 0.03}" fill="${BG}"/>
      <!-- beak -->
      <polygon points="${size*0.58},${size*0.22} ${size*0.7},${size*0.21} ${size*0.58},${size*0.26}"
        fill="#fb923c"/>
      <!-- wing accent -->
      <ellipse cx="${size * 0.5}" cy="${size * 0.65}" rx="${size * 0.22}" ry="${size * 0.14}"
        fill="${BG2}" opacity="0.35"/>
    </g>
  `;
}

// ─── Main render function ─────────────────────────────────────────────────────

/**
 * Render a single level post as an SVG string.
 *
 * @param {import('./reddit.js').LevelPost} level
 * @param {number} index   1-based position in result set
 * @param {number} total   total results in this search
 * @returns {string}  raw SVG markup
 */
export function renderLevelCard(level, index, total) {
  const title     = escapeXml(truncate(level.title, 72));
  const author    = escapeXml(level.author);
  const score     = formatScore(level.score);
  const comments  = formatScore(level.num_comments);
  const timeAgo   = relativeTime(level.created_at);
  const flair     = level.flair ? escapeXml(truncate(level.flair, 28)) : null;
  const ratio     = level.upvote_ratio ?? 0;
  const ratioBar  = Math.round(ratio * 100);
  const barColor  = ratioColor(ratio);
  const ratioBarW = Math.round((W - PAD * 2 - 2) * ratio);

  // Corner bracket decoration positions
  const bracketSize = 12;

  return `<svg xmlns="http://www.w3.org/2000/svg"
  width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
  font-family="'Courier New', Courier, monospace">

  <defs>
    ${NOISE_FILTER}
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1a2540"/>
    </linearGradient>
    <linearGradient id="accentLine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="${ACCENT}"/>
      <stop offset="100%" stop-color="${GOOSE}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="cardClip">
      <rect width="${W}" height="${H}" rx="6"/>
    </clipPath>
  </defs>

  <!-- Base card -->
  <rect width="${W}" height="${H}" rx="6" fill="url(#bgGrad)" clip-path="url(#cardClip)"/>

  <!-- Noise overlay -->
  <rect width="${W}" height="${H}" rx="6" fill="${BG2}" opacity="0.45" filter="url(#noise)"/>

  <!-- Left accent strip -->
  <rect x="0" y="0" width="4" height="${H}" rx="2" fill="${ACCENT}"/>

  <!-- Top accent line -->
  <rect x="4" y="0" width="${W - 4}" height="2" fill="url(#accentLine)"/>

  <!-- Corner brackets (retro CRT style) -->
  <!-- top-left -->
  <path d="M ${PAD} ${PAD + bracketSize} L ${PAD} ${PAD} L ${PAD + bracketSize} ${PAD}"
    stroke="${ACCENT}" stroke-width="1.5" fill="none" opacity="0.6"/>
  <!-- top-right -->
  <path d="M ${W - PAD - bracketSize} ${PAD} L ${W - PAD} ${PAD} L ${W - PAD} ${PAD + bracketSize}"
    stroke="${ACCENT}" stroke-width="1.5" fill="none" opacity="0.6"/>
  <!-- bottom-left -->
  <path d="M ${PAD} ${H - PAD - bracketSize} L ${PAD} ${H - PAD} L ${PAD + bracketSize} ${H - PAD}"
    stroke="${ACCENT}" stroke-width="1.5" fill="none" opacity="0.6"/>
  <!-- bottom-right -->
  <path d="M ${W - PAD - bracketSize} ${H - PAD} L ${W - PAD} ${H - PAD} L ${W - PAD} ${H - PAD - bracketSize}"
    stroke="${ACCENT}" stroke-width="1.5" fill="none" opacity="0.6"/>

  <!-- Result index badge -->
  <rect x="${PAD + 4}" y="${PAD + 4}" width="36" height="22" rx="4" fill="${ACCENT}" opacity="0.15"/>
  <rect x="${PAD + 4}" y="${PAD + 4}" width="36" height="22" rx="4"
    stroke="${ACCENT}" stroke-width="1" fill="none"/>
  <text x="${PAD + 22}" y="${PAD + 19}" fill="${ACCENT}" font-size="11"
    font-weight="bold" text-anchor="middle" letter-spacing="0.5">${index}/${total}</text>

  <!-- Goose icon -->
  ${gooseIcon(W - PAD - 52, PAD + 4)}

  <!-- Title -->
  <text x="${PAD + 50}" y="${PAD + 22}"
    fill="${TEXT}" font-size="15" font-weight="bold"
    letter-spacing="0.3"
    textLength="${Math.min(title.length * 8.5, W - PAD * 2 - 110)}"
    lengthAdjust="spacingAndGlyphs">${title}</text>

  <!-- Author + time row -->
  <text x="${PAD + 50}" y="${PAD + 44}"
    fill="${MUTED}" font-size="11">
    <tspan fill="${GOOSE}" font-weight="bold">u/${author}</tspan>
    <tspan fill="${MUTED}">  ·  r/honk  ·  ${timeAgo}</tspan>
  </text>

  <!-- Flair pill (if present) -->
  ${flair ? `
  <rect x="${PAD + 50}" y="${PAD + 52}" width="${flair.length * 7 + 16}" height="16" rx="8"
    fill="${ACCENT}" opacity="0.18"/>
  <rect x="${PAD + 50}" y="${PAD + 52}" width="${flair.length * 7 + 16}" height="16" rx="8"
    stroke="${ACCENT}" stroke-width="0.75" fill="none"/>
  <text x="${PAD + 58 + flair.length * 3.5}" y="${PAD + 63}"
    fill="${ACCENT}" font-size="9.5" text-anchor="middle"
    font-weight="bold" letter-spacing="0.8">${flair}</text>
  ` : ""}

  <!-- Divider -->
  <line x1="${PAD + 4}" y1="${H - 62}" x2="${W - PAD - 4}" y2="${H - 62}"
    stroke="${BORDER}" stroke-width="1"/>

  <!-- Stats row -->
  <!-- Score -->
  <text x="${PAD + 4}" y="${H - 42}"
    fill="${MUTED}" font-size="10" letter-spacing="0.5">SCORE</text>
  <text x="${PAD + 4}" y="${H - 26}"
    fill="${ACCENT}" font-size="15" font-weight="bold">${score}</text>

  <!-- Comments -->
  <text x="${PAD + 80}" y="${H - 42}"
    fill="${MUTED}" font-size="10" letter-spacing="0.5">COMMENTS</text>
  <text x="${PAD + 80}" y="${H - 26}"
    fill="${TEXT}" font-size="15" font-weight="bold">${comments}</text>

  <!-- Upvote ratio label -->
  <text x="${PAD + 200}" y="${H - 42}"
    fill="${MUTED}" font-size="10" letter-spacing="0.5">UPVOTE RATIO</text>
  <text x="${PAD + 200}" y="${H - 26}"
    fill="${barColor}" font-size="15" font-weight="bold">${ratioBar}%</text>

  <!-- Ratio progress bar track -->
  <rect x="${PAD + 200}" y="${H - 18}" width="${W - PAD * 2 - 204}" height="5"
    rx="2.5" fill="${BORDER}"/>
  <!-- Ratio progress bar fill -->
  <rect x="${PAD + 200}" y="${H - 18}" width="${Math.max(ratioBarW - 204, 4)}" height="5"
    rx="2.5" fill="${barColor}" opacity="0.85"/>

  <!-- View on Reddit link hint -->
  <text x="${W - PAD - 4}" y="${H - 26}"
    fill="${MUTED}" font-size="10" text-anchor="end"
    letter-spacing="0.3">reddit.com/r/honk</text>
  <text x="${W - PAD - 4}" y="${H - 13}"
    fill="${ACCENT}" font-size="9.5" text-anchor="end"
    letter-spacing="0.3" opacity="0.8">↗ ${escapeXml(truncate(level.url, 55))}</text>

</svg>`;
}
