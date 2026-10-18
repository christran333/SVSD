// SVSD toolkit — local dev server.
// Zero dependencies (Node 20+). Serves /public, keeps the API key on the server,
// and exposes two endpoints:
//   POST /api/search  { q, from }  -> candidates found with Claude + web search, each with a preview
//   GET  /api/preview?url=...      -> { image, favicon } for any saved link
//   POST /api/flow    { goal, items } -> a step-by-step workflow built from the toolkit
//   GET  /api/status               -> { live: boolean, model }

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// ---------- tiny .env loader (no dotenv needed) ----------
(function loadEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const PORT = Number(process.env.PORT) || 3000;
// Forgive messy pastes (spaces, quotes, line breaks, or the whole "ANTHROPIC_API_KEY=..." line).
const API_KEY = String(process.env.ANTHROPIC_API_KEY || "").replace(/\s+/g, "").replace(/["']/g, "").replace(/^ANTHROPIC_API_KEY=/, "");
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const PUBLIC = path.join(__dirname, "public");
// Bump together with APP_SERVER_VERSION in public/index.html whenever the API changes.
const SERVER_VERSION = 5;

// ---------- helpers ----------
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const readBody = (req) => ("body" in req && req.body !== undefined) ? Promise.resolve(typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {})) : new Promise((ok, bad) => {
  let d = ""; req.on("data", (c) => { d += c; if (d.length > 8e6) req.destroy(); }); // 8MB: room for one downscaled photo
  req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { bad(e); } });
});
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal, redirect: "follow" }); }
  finally { clearTimeout(t); }
}

// ---------- previews ----------
function youTubeId(u) {
  try {
    const url = new URL(u);
    if (url.hostname === "youtu.be") return url.pathname.slice(1, 12) || null;
    if (/(^|\.)youtube\.com$/.test(url.hostname)) {
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const m = /^\/(shorts|embed|live)\/([\w-]{11})/.exec(url.pathname);
      if (m) return m[2];
    }
  } catch {}
  return null;
}

const previewCache = new Map();
async function previewFor(rawUrl) {
  if (!/^https?:\/\//.test(rawUrl || "")) return { image: "", favicon: "" };
  if (previewCache.has(rawUrl)) return previewCache.get(rawUrl);
  const host = hostOf(rawUrl);
  const out = { image: "", favicon: host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128` : "" };

  const vid = youTubeId(rawUrl);
  if (vid) {
    // maxres isn't generated for every video; the client falls back to hq on error.
    out.image = `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`;
    out.fallback = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  } else {
    try {
      const r = await fetchWithTimeout(rawUrl, 5000, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) SVSD-preview/0.1", accept: "text/html" } });
      if (r.ok && /html/.test(r.headers.get("content-type") || "")) {
        const html = (await r.text()).slice(0, 400_000);
        const meta = (prop) => {
          const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, "i");
          const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
          return (re1.exec(html) || re2.exec(html) || [])[1] || "";
        };
        const img = meta("og:image") || meta("og:image:url") || meta("twitter:image") || meta("twitter:image:src");
        if (img) out.image = new URL(img.replace(/&amp;/g, "&"), r.url).href;
      }
    } catch {}
  }
  previewCache.set(rawUrl, out);
  return out;
}

// ---------- search with Claude + web search ----------
async function search(q, from, stashes = [], image = "") {
  const stashList = (Array.isArray(stashes) ? stashes : []).map(String).slice(0, 30);
  const img = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(String(image || ""));
  const intro = img
    ? `A designer snapped a photo or screenshot of something they want to remember: a tool, app, site, video or creator they saw (on a friend's screen, a tweet, a slide, a poster). First read the image: product names, logos, URLs, handles. Then use web search to find the actual thing and return up to 3 candidate links, best match first. If the image shows several different tools, return each one.`
    : `A designer jotted down a quick note about something someone recommended: usually a design or dev tool, plugin, component, AI app, website, video or creator. Find exactly what they mean and return up to 3 candidate links, best match first.`;
  const prompt = `${intro}

${q ? `Their note: """${String(q).slice(0, 500)}"""` : ""}
${from ? `Who told them: """${String(from).slice(0, 200)}"""` : ""}

How to search well:
- Notes may be spoken out loud and transcribed, full of filler ("hey so my friend was talking about..."). Pull out the actual clues and ignore the rest.
- If the note DESCRIBES what the thing does instead of naming it ("a tool that makes a bunch of variants of a design"), search by that description and return 3 DIFFERENT real products that fit, the most likely first, each with confidence "medium" or "low" unless one clearly matches every detail.
- These are often niche or brand new: indie tools announced on X, GitHub repos, Framer/Figma plugins, AI apps, personal projects. Don't settle for a famous product that merely shares a word.
- Notes are written the way people talk: misspelled, spaced oddly, phonetic, half-remembered ("dial kit" = DialKit, "agentation" = Agentation). Search spelling variants: joined words, with ".com", ".dev", "app", plus "github" or "x.com".
- A person's name is a strong clue: it's usually the creator. Search their name with the tool words, and check their site, X and GitHub for the project.
- Use the "who told them" and any descriptive words ("animation tuning", "for vibe coding") to pick between same-named things.
- Run several searches before deciding. Verify the name on the page actually matches.

Rules:
- Every URL must come from your search results. Prefer the official homepage, then the GitHub repo, then the creator's announcement post. Never return a search-engine results page.
- If the note could mean several different things, return the different interpretations.
- "kind" is one of: tool, site, video, article.
- "blurb" is one plain sentence (max 18 words) on what it is or does.
- If the note or image shows a piece of work someone made (an animation, a website, an illustration, a video, a 3D scene) rather than a tool or product they could use, put this FIRST: {"kind":"work","title":"<short name for the piece>","url":"<its source link if you found one, else empty>","blurb":"<what it is>"}. Then list any tools you can already tell were used, if any.
- "brand" is the product's main brand color as #RRGGBB if obvious, else "".
- "stash" is the best-fitting group for it from this list: ${JSON.stringify(stashList)}. If none fit, suggest a new 1-2 word name.
- "why" is one short line on why it fits their note, pointing at the matching detail (max 14 words).
- "confidence" is "high" only if the name and details clearly match the note, "medium" if likely, "low" if it's a guess. Order results by confidence.

Finish with only a JSON array, no other text, like:
[{"title":"Agentation","url":"https://github.com/benjitaylor/agentation","kind":"tool","blurb":"Comment on UI elements and send the batch to your coding agent.","brand":"#0E1116","stash":"Design tools","confidence":"high","why":"Matches the name and the 'comment on the UI' detail."}]`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: img
        ? [{ type: "image", source: { type: "base64", media_type: img[1], data: img[2] } }, { type: "text", text: prompt }]
        : prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    const err = new Error(data?.error?.message || `Claude API error ${r.status}`);
    err.status = r.status; throw err;
  }

  // URLs Claude actually saw in search results, used to mark candidates as verified.
  const seen = new Set();
  for (const b of data.content || []) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach((x) => x.url && seen.add(x.url));
  }
  const texts = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
  const last = texts[texts.length - 1] || "";
  const jsonText = (/\[[\s\S]*\]/.exec(last) || [])[0];
  let list = [];
  try { list = JSON.parse(jsonText); } catch { throw new Error("Claude's answer wasn't in the expected format. Try again."); }

  const cands = (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x.title === "string" && (x.kind === "work" || (typeof x.url === "string" && /^https?:\/\//.test(x.url))))
    .filter((x) => !/(google|bing|duckduckgo)\.[a-z.]+\/search/i.test(x.url || ""))
    .slice(0, 4)
    .map((x) => ({
      title: x.title.slice(0, 80),
      url: /^https?:\/\//.test(x.url || "") ? x.url : "",
      kind: ["tool", "site", "video", "article", "work"].includes(x.kind) ? x.kind : "site",
      blurb: String(x.blurb || "").slice(0, 160),
      brand: /^#[0-9a-f]{6}$/i.test(x.brand || "") ? x.brand : "",
      stash: typeof x.stash === "string" ? x.stash.slice(0, 24) : "",
      confidence: ["high", "medium", "low"].includes(x.confidence) ? x.confidence : "medium",
      why: String(x.why || "").slice(0, 140),
      verified: [...seen].some((s) => s === x.url || hostOf(s) === hostOf(x.url)),
    }));

  await Promise.all(cands.map(async (c) => Object.assign(c, await previewFor(c.url))));
  return cands;
}

// ---------- how was this made? ----------
async function howMade({ title = "", url = "", blurb = "", forWhat = "", image = "" }, stashes = []) {
  const img = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(String(image || ""));
  const prompt = `A designer saved something that impressed them and wants to know how it was made: which tools, libraries, frameworks, plugins or techniques were used, so they can try them.

Thing: ${String(title).slice(0, 120)}
${url ? `Link: ${String(url).slice(0, 400)}` : ""}
${blurb ? `About: ${String(blurb).slice(0, 300)}` : ""}
${forWhat ? `Their note: ${String(forWhat).slice(0, 300)}` : ""}
${img ? "The attached image is where they saw it (a screenshot or photo). Read it for names, handles, links." : ""}

Use web search to find real evidence: the maker's posts or threads, a case study, a GitHub repo, a talk, a "built with" credit, the site's own source hints. Do not guess a stack without evidence; if you can't find much, say so in the summary and return fewer tools.

Finish with only a JSON object, no other text, like:
{"summary":"One or two plain sentences on how it was made and how sure you are.","tools":[{"title":"Rive","url":"https://rive.app","kind":"tool","role":"Interactive animations in the hero","brand":"#1D1D1D","stash":"Motion"}]}
- Up to 5 tools, most important first. "role" says what it was used for in this project, max 12 words.
- "stash" is the best fit from ${JSON.stringify((stashes || []).map(String).slice(0, 30))} or a new 1-2 word name.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: img ? [{ type: "image", source: { type: "base64", media_type: img[1], data: img[2] } }, { type: "text", text: prompt }] : prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) { const err = new Error(data?.error?.message || `Claude API error ${r.status}`); err.status = r.status; throw err; }
  const texts = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
  const last = texts[texts.length - 1] || "";
  let out;
  try { out = JSON.parse((/\{[\s\S]*\}/.exec(last) || [])[0]); } catch { throw new Error("Couldn't piece together how this was made. Try again."); }
  const tools = (Array.isArray(out.tools) ? out.tools : [])
    .filter((x) => x && typeof x.title === "string" && /^https?:\/\//.test(x.url || ""))
    .slice(0, 5)
    .map((x) => ({
      title: x.title.slice(0, 60), url: x.url, kind: ["tool", "site", "video", "article"].includes(x.kind) ? x.kind : "tool",
      role: String(x.role || "").slice(0, 120), blurb: String(x.role || "").slice(0, 120),
      brand: /^#[0-9a-f]{6}$/i.test(x.brand || "") ? x.brand : "", stash: typeof x.stash === "string" ? x.stash.slice(0, 24) : "",
    }));
  await Promise.all(tools.map(async (c) => Object.assign(c, await previewFor(c.url))));
  return { summary: String(out.summary || "").slice(0, 400), tools };
}

// ---------- workflow: chain toolkit tools (plus a few suggestions) into steps for a goal ----------
async function workflow(goal, items = []) {
  const kit = (Array.isArray(items) ? items : []).slice(0, 60).map((x) => ({
    id: String(x.id || ""), title: String(x.title || "").slice(0, 60), url: String(x.url || "").slice(0, 200),
    status: String(x.status || ""), about: String(x.forWhat || x.blurb || "").slice(0, 160), kind: String(x.kind || ""),
  }));
  const prompt = `A designer wants to make something and asked for a simple workflow built from their own toolkit.

Goal: ${String(goal).slice(0, 400)}

Their toolkit (status: using = uses it now, tried = tried it, want = saved but hasn't tried yet, nope = didn't like it):
${JSON.stringify(kit)}

Build a short, practical workflow: 3 to 6 steps in the order they'd actually work.
- Each step uses one tool. Prefer tools from their toolkit, including ones they want to try when they genuinely fit; that's the point, to get them using what they saved. Skip "nope" tools.
- Only add a tool that isn't in their toolkit when there's a real gap (at most 2). Use real, well-known tools with their official homepage URL.
- Don't force a toolkit tool that doesn't fit the goal. Videos or articles can be a step if they're a reference for the work.

Finish with only a JSON object, no other text, like:
{"title":"Mobile micro-interaction","summary":"One plain sentence on the approach.","steps":[{"id":"<toolkit id, or empty for a suggestion>","title":"Rive","url":"https://rive.app","step":"Animate the interaction","use":"Build the button's press and release states as a state machine","brand":"#1D1D1D"}]}
- "step" is a 2-5 word verb phrase. "use" says what this tool does in THIS workflow, max 16 words.
- "title" under 40 characters.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await r.json();
  if (!r.ok) { const err = new Error(data?.error?.message || `Claude API error ${r.status}`); err.status = r.status; throw err; }
  const last = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).pop() || "";
  let out;
  try { out = JSON.parse((/\{[\s\S]*\}/.exec(last) || [])[0]); } catch { throw new Error("Couldn't map out a workflow. Try again."); }
  const ids = new Set(kit.map((k) => k.id));
  const steps = (Array.isArray(out.steps) ? out.steps : []).filter((x) => x && typeof x.title === "string").slice(0, 6).map((x) => {
    const id = ids.has(String(x.id || "")) ? String(x.id) : "";
    return {
      id, title: x.title.slice(0, 40), url: /^https?:\/\//.test(x.url || "") ? x.url : "",
      step: String(x.step || "").slice(0, 40), use: String(x.use || "").slice(0, 160),
      brand: /^#[0-9a-f]{6}$/i.test(x.brand || "") ? x.brand : "",
    };
  }).filter((x) => x.id || x.url);
  await Promise.all(steps.filter((x) => !x.id).map(async (x) => Object.assign(x, await previewFor(x.url))));
  return { title: String(out.title || "").slice(0, 60), summary: String(out.summary || "").slice(0, 240), steps };
}

// ---------- server ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".jpg": "image/jpeg" };

// ---------- API routes (shared by the local server and Vercel's api/index.js) ----------
const NO_KEY = process.env.VERCEL ? "No API key on Vercel yet. Add ANTHROPIC_API_KEY in Project Settings → Environment Variables, then redeploy." : "No API key yet. Add ANTHROPIC_API_KEY to .env and restart the server.";
async function handleApi(req, res, pathname) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (pathname) url.pathname = pathname;
  try {
    if (url.pathname === "/api/status") return send(res, 200, { live: Boolean(API_KEY), model: MODEL, version: SERVER_VERSION });

    if (url.pathname === "/api/preview") return send(res, 200, await previewFor(url.searchParams.get("url")));

    if (url.pathname === "/api/search" && req.method === "POST") {
      if (!API_KEY) return send(res, 400, { error: NO_KEY });
      const { q, from, stashes, image } = await readBody(req);
      if ((!q || !String(q).trim()) && !image) return send(res, 400, { error: "Type what you heard about, or add a photo." });
      return send(res, 200, { candidates: await search(q || "", from, stashes, image) });
    }

    if (url.pathname === "/api/made" && req.method === "POST") {
      if (!API_KEY) return send(res, 400, { error: NO_KEY });
      const { item, stashes } = await readBody(req);
      return send(res, 200, await howMade(item || {}, stashes));
    }

    if (url.pathname === "/api/flow" && req.method === "POST") {
      if (!API_KEY) return send(res, 400, { error: NO_KEY });
      const { goal, items } = await readBody(req);
      if (!goal || !String(goal).trim()) return send(res, 400, { error: "Say what you're trying to make." });
      return send(res, 200, await workflow(goal, items));
    }

    return send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    return send(res, e.status === 401 ? 401 : 500, { error: e.status === 401 ? (process.env.VERCEL ? "The API key was rejected. In Vercel → Settings → Environment Variables, re-paste ANTHROPIC_API_KEY (just the sk-ant-… part), then Redeploy." : "The API key was rejected. Check ANTHROPIC_API_KEY in .env.") : e.message || "Something went wrong." });
  }
}
// One handler for every request: the API, plus the app's files.
async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res);
  try {
    // static files
    let file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, "index.html");
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message || "Something went wrong." });
  }
}
// Vercel calls the exported handler (and serves public/ from its CDN).
// Locally, `npm start` runs this file and we start a normal server.
module.exports = handler;
module.exports.handleApi = handleApi;
// (Vercel sets VERCEL=1, so no server is started there.)

if (!process.env.VERCEL) http.createServer(handler).on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`\n  Port ${PORT} is already in use, probably an older copy of this server still running.`);
    console.log(`  Stop it and start fresh with:\n\n    lsof -ti :${PORT} | xargs kill; npm start\n`);
    process.exit(1);
  }
  throw e;
}).listen(PORT, () => {
  console.log(`\n  SVSD toolkit running at http://localhost:${PORT}`);
  // List every network address, Wi-Fi (en0) first. VPNs and virtual adapters show up too, so the first one isn't always right.
  const nets = Object.entries(require("node:os").networkInterfaces())
    .flatMap(([name, list]) => (list || []).filter((n) => n.family === "IPv4" && !n.internal).map((n) => ({ name, ip: n.address })))
    .sort((a, b) => (b.name === "en0") - (a.name === "en0"));
  if (nets.length) {
    console.log("  On your phone (same Wi-Fi), try:");
    nets.forEach((n) => console.log(`    http://${n.ip}:${PORT}   (${n.name === "en0" ? "Wi-Fi" : n.name})`));
  }
  console.log(API_KEY ? `  Live search on (${MODEL})\n` : "  No API key found: test mode only. Add ANTHROPIC_API_KEY to .env\n");
});
