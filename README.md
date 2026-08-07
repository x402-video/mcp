# x402-video MCP server

Give any MCP-capable agent (Claude Code, Claude Desktop, Cursor, ...) the ability to
**generate AI videos and pay per call** — USDC on Base over the
[x402 protocol](https://docs.x402.org). No accounts, no API keys, no credit cards.

```
quote_price → generate_video (pays exact USDC quote, gasless) → get_job → video_url
```

Backed by [x402video.com](https://x402video.com): ~$0.45 for a 5s 720p clip,
custom 4–15s up to 1080p with optional audio ($0.13–$4.62). Prompts are screened
**before** payment — rejected requests are never charged.

## Tools

| Tool | Cost | What |
|---|---|---|
| `list_skus` | free | Live catalog + current USD prices |
| `get_stats` | free | Public reliability stats (success rate, p50 generation time) |
| `quote_price` | free | Exact USDC quote for a request, without paying |
| `generate_video` | paid | Quote → spend-guard check → pay → `job_id` |
| `get_job` | free | Poll status; returns `video_url` on success (24h link) |
| `submit_feedback` | free | Tell humans: price / missing feature / quality / bug / cheaper source |

## Setup

You need a **dedicated spending wallet** with a few USDC on Base (8453).
Never use your main wallet — see the 5-minute
[getting-started guide](https://github.com/x402-video/web/blob/main/GETTING-STARTED.md).

### Claude Code

```bash
claude mcp add x402-video \
  --env BUYER_PRIVATE_KEY=0xYOUR_SPENDING_WALLET_KEY \
  -- npx -y x402-video-mcp
```

### Claude Desktop / Cursor (JSON)

```json
{
  "mcpServers": {
    "x402-video": {
      "command": "npx",
      "args": ["-y", "x402-video-mcp"],
      "env": {
        "BUYER_PRIVATE_KEY": "0xYOUR_SPENDING_WALLET_KEY"
      }
    }
  }
}
```

Without `BUYER_PRIVATE_KEY` the free tools (catalog, quotes, job polling, feedback) still work;
only `generate_video` requires the wallet.

### Feedback (free)

Agents can report product needs without paying:

```
submit_feedback({
  message: "Need wait_for_job so I don't burn tokens polling",
  category: "feature",
  suggested_price_usd: 0.5
})
```

Categories: `pricing` | `feature` | `quality` | `bug` | `source` | `other`.
Also available as raw HTTP: `POST https://api.x402video.com/feedback`.

## Environment variables

| Var | Default | |
|---|---|---|
| `BUYER_PRIVATE_KEY` | — | Spending wallet key (USDC on Base). Required only for `generate_video`. |
| `MAX_USD_PER_CALL` | `5` | Hard spend guard — `generate_video` refuses quotes above this. |
| `GATEWAY_URL` | `https://api.x402video.com` | Point at another gateway instance. |

## How payment works

1. The tool POSTs your request unpaid; the gateway answers `HTTP 402` with the **exact**
   USDC amount for that request (a free quote).
2. If the quote is within `MAX_USD_PER_CALL`, the request is retried with an x402
   payment header — an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) signature,
   so the buyer pays **no gas**.
3. You get a `job_id`; generation takes ~2 minutes (p50). Poll `get_job`, download
   `video_url` within 24h.

## Develop

```bash
npm install
npm run build
BUYER_PRIVATE_KEY=0x... node dist/index.js   # speaks MCP over stdio
```

## Content policy

Hard red lines (rejected pre-payment, never charged): content involving minors,
real-person likeness/deepfakes. Sexually explicit content and graphic violence are
rejected.

---

MIT. Independent gateway — not affiliated with or endorsed by model vendors.
