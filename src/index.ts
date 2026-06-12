#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "0.1.3";
const GATEWAY = (process.env.GATEWAY_URL ?? "https://api.x402video.com").replace(/\/$/, "");
const MAX_USD_PER_CALL = Number(process.env.MAX_USD_PER_CALL ?? "5");

// Channel attribution for the gateway's ledger: which MCP host (Claude, Cursor, ...)
// the buyer is calling from. No wallet or user data — name/version only.
function trackingHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": `x402-video-mcp/${VERSION}` };
  const info = server.server.getClientVersion();
  if (info?.name) headers["x-client"] = `${info.name}/${info.version ?? "?"}`.slice(0, 64);
  return headers;
}

const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"] as const;
const RESOLUTIONS = ["480p", "720p", "1080p"] as const;

const generateParams = {
  prompt: z.string().min(1).describe("Text prompt describing the video"),
  model: z
    .enum(["seedance-fast", "seedance"])
    .default("seedance-fast")
    .describe("seedance-fast: cheaper/faster. seedance: highest quality."),
  ratio: z.enum(RATIOS).optional().describe("Aspect ratio (default 16:9; 9:16 for vertical/shorts)"),
  duration: z.number().int().min(4).max(15).optional().describe("Seconds, 4-15 (custom pricing)"),
  resolution: z.enum(RESOLUTIONS).optional().describe("480p/720p/1080p (custom pricing)"),
  generate_audio: z.boolean().optional().describe("Generate audio track (+10% price)"),
  camera_fixed: z.boolean().optional().describe("Lock the camera in place"),
  seed: z.number().int().optional().describe("Deterministic seed (-1 = random)"),
};

type GenerateArgs = {
  prompt: string;
  model: "seedance-fast" | "seedance";
  ratio?: (typeof RATIOS)[number];
  duration?: number;
  resolution?: (typeof RESOLUTIONS)[number];
  generate_audio?: boolean;
  camera_fixed?: boolean;
  seed?: number;
};

function buildRequest(args: GenerateArgs): { url: string; body: Record<string, unknown> } {
  const custom =
    args.duration !== undefined ||
    args.resolution !== undefined ||
    args.generate_audio !== undefined ||
    args.camera_fixed !== undefined ||
    args.seed !== undefined;
  const body: Record<string, unknown> = { prompt: args.prompt };
  if (args.ratio) body.ratio = args.ratio;
  if (custom) {
    for (const k of ["duration", "resolution", "generate_audio", "camera_fixed", "seed"] as const) {
      if (args[k] !== undefined) body[k] = args[k];
    }
  }
  return { url: `${GATEWAY}/generate/${args.model}/${custom ? "custom" : "5s-720p"}`, body };
}

async function probe(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...trackingHeaders() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (res.status !== 402) {
    throw new Error(
      `Gateway did not quote a price (HTTP ${res.status}): ${text.slice(0, 500)}` +
        (res.status === 403 ? " — prompt was rejected by the content filter (you were not charged)." : ""),
    );
  }
  let priceUsd: number | null = typeof json?.price_usd === "number" ? json.price_usd : null;
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      const amount = decoded?.accepts?.[0]?.amount ?? decoded?.accepts?.[0]?.maxAmountRequired;
      if (amount) priceUsd = Number(amount) / 1e6;
    } catch {
      /* fall back to body price */
    }
  }
  if (priceUsd === null) throw new Error(`402 received but no price found: ${text.slice(0, 300)}`);
  return { priceUsd, sku: json?.sku as string | undefined };
}

let fetchPay: typeof fetch | null = null;
async function getPayingFetch(): Promise<typeof fetch> {
  if (fetchPay) return fetchPay;
  const key = process.env.BUYER_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "BUYER_PRIVATE_KEY is not set. Create a dedicated spending wallet, fund it with a few USDC on Base, " +
        "and set BUYER_PRIVATE_KEY=0x... in this MCP server's env. " +
        "Guide: https://github.com/x402-video/web/blob/main/GETTING-STARTED.md",
    );
  }
  const [{ ExactEvmScheme, toClientEvmSigner }, { wrapFetchWithPayment, x402Client }, viem, accounts, chains] =
    await Promise.all([
      import("@x402/evm"),
      import("@x402/fetch"),
      import("viem"),
      import("viem/accounts"),
      import("viem/chains"),
    ]);
  const account = accounts.privateKeyToAccount(key as `0x${string}`);
  const signer = toClientEvmSigner(
    account,
    viem.createPublicClient({ chain: chains.base, transport: viem.http() }),
  );
  fetchPay = wrapFetchWithPayment(
    fetch,
    new x402Client().register("eip155:*", new ExactEvmScheme(signer)),
  ) as typeof fetch;
  return fetchPay;
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: "x402-video", version: VERSION });

server.registerTool(
  "list_skus",
  {
    title: "List video SKUs and prices",
    description:
      "Live catalog of pay-per-call video generation endpoints with current USD prices (free call). " +
      "Fixed-price SKUs (~$0.45-0.56 for 5s 720p) and custom endpoints (4-15s, up to 1080p, optional audio).",
  },
  async () => {
    const res = await fetch(`${GATEWAY}/`);
    return jsonResult(await res.json());
  },
);

server.registerTool(
  "get_stats",
  {
    title: "Gateway reliability stats",
    description: "Live public stats: success rate, p50 generation seconds, total delivered (free call).",
  },
  async () => {
    const res = await fetch(`${GATEWAY}/status`);
    return jsonResult(await res.json());
  },
);

server.registerTool(
  "quote_price",
  {
    title: "Quote exact price (no payment)",
    description:
      "Get the exact USDC price for a generation request without paying. Free call — useful before generate_video.",
    inputSchema: generateParams,
  },
  async (args) => {
    const { url, body } = buildRequest(args as GenerateArgs);
    const quote = await probe(url, body);
    return jsonResult({ endpoint: url, request_body: body, price_usd: quote.priceUsd, sku: quote.sku });
  },
);

server.registerTool(
  "generate_video",
  {
    title: "Generate a video (paid)",
    description:
      "Generate an AI video, paying per call in USDC on Base via x402 (gasless EIP-3009 signature). " +
      "Quotes the exact price first and refuses if it exceeds MAX_USD_PER_CALL (default $5). " +
      "Returns a job_id — poll get_job until status is 'succeeded' (typically ~2 minutes). " +
      "Prompts are screened before payment; rejected prompts are never charged.",
    inputSchema: generateParams,
  },
  async (args) => {
    const { url, body } = buildRequest(args as GenerateArgs);
    const quote = await probe(url, body);
    if (quote.priceUsd > MAX_USD_PER_CALL) {
      throw new Error(
        `Quoted price $${quote.priceUsd} exceeds MAX_USD_PER_CALL ($${MAX_USD_PER_CALL}). ` +
          "Lower duration/resolution, or raise the MAX_USD_PER_CALL env var to allow this.",
      );
    }
    const pay = await getPayingFetch();
    const res = await pay(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...trackingHeaders() },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Payment/generation failed (HTTP ${res.status}): ${JSON.stringify(json)?.slice(0, 500)}`);
    }
    return jsonResult({
      paid_usd: quote.priceUsd,
      job_id: json.job_id,
      status: json.status,
      status_url: `${GATEWAY}${json.status_url ?? `/jobs/${json.job_id}`}`,
      next: "Poll get_job with this job_id until status is 'succeeded', then download video_url (expires in 24h).",
    });
  },
);

server.registerTool(
  "get_job",
  {
    title: "Check job status / get video URL",
    description:
      "Poll a generation job (free call). status: queued/running/succeeded/failed. " +
      "On success returns video_url (download within 24h).",
    inputSchema: { job_id: z.string().min(1).describe("Job id returned by generate_video") },
  },
  async ({ job_id }) => {
    const res = await fetch(`${GATEWAY}/jobs/${encodeURIComponent(job_id)}`);
    if (!res.ok) throw new Error(`Job lookup failed (HTTP ${res.status})`);
    return jsonResult(await res.json());
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
