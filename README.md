# SVSD Toolkit (working name)

For unorganized creatives: when a friend mentions a tool, video or site, jot it on the yellow note,
let Claude find the right link, and file it into a group. Mobile app shown in a phone frame on desktop,
with a prototype-controls panel on the side.

## Run it

Needs Node 20 or newer. No packages to install.

```bash
cp .env.example .env      # then paste your key into .env
npm start                 # opens on http://localhost:3000
```

Get an API key from the Claude Console (console.anthropic.com → API keys) and add some credits.
Never paste the key into chat, Slack or a commit; `.env` is gitignored.

## Test vs Live

- **Test**: canned search results, no API calls. Use it while tuning UI and motion.
- **Live**: each "Find it" runs Claude with web search (up to 3 searches), roughly a few cents.
  Results that didn't appear in the search itself are marked "unverified".

Previews are fetched by the server: YouTube thumbnails, a site's og:image, and favicons.
That part needs no API key.

## Files

- `server.js`: local server. Holds the key, `/api/search`, `/api/preview`, `/api/status`.
- `public/index.html`: the whole app (phone frame, capture flow, cards, side panel).

## Working together

Pull before you start, split by area (one person per screen or flow), push small commits.
