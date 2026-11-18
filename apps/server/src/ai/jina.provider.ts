import { z, type ZodTypeAny } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import {
  AiProviderError,
  type AIProvider,
  type AiUsage,
  type GenerationImage,
} from "./ai.provider.js";

/**
 * The Jina implementation of `AIProvider`.
 *
 * This is the **only** file that talks to Jina. Everything above the interface
 * stays SDK-free and therefore provider-agnostic.
 *
 * - Embeddings use `jina-embeddings-v5-text-small` (1024-dim, within the
 *   pgvector HNSW 2000-dim ceiling) on `api.jina.ai`. `task: "retrieval.query"`
 *   and `normalized: true` keep stored and queried vectors comparable.
 * - Generation uses `jina-vlm`, which Jina serves from its **own** host
 *   (`JINA_CHAT_BASE_URL`). `api.jina.ai/v1/chat/completions` only accepts
 *   `jina-ocr-v1` and answers every `jina-vlm` request with a 422 — pointing
 *   generation there silently put every AI feature on its fallback.
 * - Jina rejects a `system` role (conversation roles must alternate), so the
 *   system prompt is merged into the user turn.
 * - The expected output is described to the model as an **example object**, not
 *   a JSON Schema. Given a schema (`{"type":"object","properties":…}`), jina-vlm
 *   copies its wrapper and nests the real answer under `properties`; given an
 *   example, it fills the example in.
 * - The provider is created lazily and only when configured — a missing key
 *   leaves every AI feature on its non-AI fallback instead of crashing at boot.
 */

/** Upstream deadlines. A hung provider must degrade a feature, never hold a request open. */
const EMBED_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_MS = 60_000;
const OCR_TIMEOUT_MS = 30_000;

function getApiKey(): string {
  if (!env.JINA_API_KEY) {
    throw new AppError("The AI provider is not configured on this server", 503);
  }
  return env.JINA_API_KEY;
}

/**
 * Renders a Zod schema as an **example instance** the model fills in, e.g.
 * `{"answer":"<string>","flag":"<one of: LOW | HIGH> or null"}`.
 */
export function exampleFor(schema: ZodTypeAny): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    const out: Record<string, unknown> = {};
    for (const [key, fieldSchema] of Object.entries(shape)) out[key] = exampleFor(fieldSchema);
    return out;
  }
  if (schema instanceof z.ZodArray) {
    const element = (schema._def as unknown as { element: ZodTypeAny }).element;
    return [exampleFor(element)];
  }
  if (schema instanceof z.ZodEnum) {
    const entries = (schema._def as unknown as { entries: Record<string, string> }).entries;
    return `<one of: ${Object.values(entries).join(" | ")}>`;
  }
  if (schema instanceof z.ZodString) return "<string>";
  if (schema instanceof z.ZodNumber) return 0;
  if (schema instanceof z.ZodBoolean) return false;
  if (schema instanceof z.ZodLiteral) return (schema._def as { value?: unknown }).value ?? null;
  if (schema instanceof z.ZodNullable) {
    const inner = exampleFor((schema._def as unknown as { innerType: ZodTypeAny }).innerType);
    return typeof inner === "string" ? `${inner} or null` : inner;
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return exampleFor((schema._def as unknown as { innerType: ZodTypeAny }).innerType);
  }
  return null;
}

/** Field names the schema expects at the top level, or null when it is not an object. */
function topLevelKeys(schema: ZodTypeAny): string[] | null {
  if (!(schema instanceof z.ZodObject)) return null;
  return Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape);
}

/**
 * Undoes the schema-echo failure: `{"type":"object","properties":{…answer…}}`
 * becomes `{…answer…}` — but only when the schema itself does not expect a
 * `properties` field, so a legitimate payload is never rewritten.
 */
export function unwrapEchoedSchema(value: unknown, schema: ZodTypeAny): unknown {
  const keys = topLevelKeys(schema);
  if (!keys || keys.includes("properties")) return value;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "properties" in value &&
    typeof (value as { properties: unknown }).properties === "object" &&
    (value as { properties: unknown }).properties !== null &&
    !keys.some((k) => k in value)
  ) {
    return (value as { properties: unknown }).properties;
  }
  return value;
}

/** Extracts the JSON object from a reply that may carry a code fence or trailing prose. */
export function extractJson(content: string): string {
  const trimmed = content.trim();
  const fence = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)(?:\n)?```/);
  if (fence) return fence[1].trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // A small model sometimes appends prose after the object. Cut at the matching
    // closing brace so the object still parses.
    const end = matchingBrace(trimmed);
    if (end > 0) return trimmed.slice(0, end + 1);
  }
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    const tail = trimmed.slice(start);
    const end = matchingBrace(tail);
    if (end > 0) return tail.slice(0, end + 1);
  }
  return trimmed;
}

/** Index of the brace that closes the one at position 0, honouring strings. */
function matchingBrace(text: string): number {
  const open = text[0];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

class JinaProvider implements AIProvider {
  private latencyMs?: number;
  private tokensUsed?: number;

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const start = Date.now();
    const res = await request(
      `${env.JINA_EMBED_BASE_URL}/embeddings`,
      {
        model: env.JINA_EMBED_MODEL,
        task: "retrieval.query",
        normalized: true,
        input: texts,
      },
      EMBED_TIMEOUT_MS,
    );
    this.latencyMs = Date.now() - start;

    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    const values = data.data?.map((d) => d.embedding) ?? [];
    if (values.length !== texts.length) {
      throw new AiProviderError("Embedding provider returned an unexpected shape", 502, false);
    }
    return values;
  }

  async generate<T>(opts: {
    prompt: string;
    schema: z.ZodType<T>;
    system?: string;
    maxTokens?: number;
    images?: GenerationImage[];
  }): Promise<T> {
    const start = Date.now();

    const example = JSON.stringify(exampleFor(opts.schema as unknown as ZodTypeAny));
    const outputRule = `Reply with ONLY one JSON object shaped like this example, with every placeholder replaced by real content (no code fences, no prose before or after):\n${example}`;
    const textPrompt = [opts.system, outputRule, opts.prompt].filter(Boolean).join("\n\n");

    const content: unknown =
      opts.images && opts.images.length > 0
        ? [
            { type: "text", text: textPrompt },
            ...opts.images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mimeType};base64,${img.data}` },
            })),
          ]
        : textPrompt;

    const res = await request(
      `${env.JINA_CHAT_BASE_URL}/chat/completions`,
      {
        model: env.JINA_CHAT_MODEL,
        messages: [{ role: "user", content }],
        response_format: { type: "json_object" },
        max_tokens: opts.maxTokens ?? 1024,
        temperature: 0.2,
      },
      CHAT_TIMEOUT_MS,
    );
    this.latencyMs = Date.now() - start;

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    this.tokensUsed = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new AppError("The AI provider declined to generate a response", 422);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(text));
    } catch {
      throw new AiProviderError("The AI provider returned unparseable output", 502, true);
    }
    return unwrapEchoedSchema(parsed, opts.schema as unknown as ZodTypeAny) as T;
  }

  async transcribe(image: GenerationImage): Promise<string> {
    const start = Date.now();
    // jina-ocr-v1 reads exactly one page image and returns its text; it takes no
    // instructions and needs none.
    const res = await request(
      `${env.JINA_OCR_BASE_URL}/chat/completions`,
      {
        model: env.JINA_OCR_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${image.mimeType};base64,${image.data}` },
              },
            ],
          },
        ],
      },
      OCR_TIMEOUT_MS,
    );
    this.latencyMs = Date.now() - start;

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    this.tokensUsed = data.usage?.total_tokens;
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AiProviderError("The OCR model found no readable text", 422, false);
    return text;
  }

  lastUsage(): AiUsage {
    return { latencyMs: this.latencyMs, tokensUsed: this.tokensUsed };
  }
}

/** POSTs JSON with a deadline and maps every failure to a typed provider error. */
async function request(url: string, body: unknown, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getApiKey()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new AiProviderError("The AI service took too long to respond", 504, true);
    }
    const message = err instanceof Error && err.message ? err.message.slice(0, 300) : "";
    throw new AiProviderError(message || "AI provider request failed", 502, true);
  }
  if (!res.ok) throw await toHttpError(res);
  return res;
}

async function toHttpError(res: Response): Promise<AiProviderError> {
  let message = `AI provider request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as {
      detail?: { message?: string } | string;
      message?: string;
    };
    const raw = typeof body?.detail === "string" ? body.detail : body?.detail?.message;
    if (raw) message = raw.slice(0, 300);
    else if (body?.message) message = body.message.slice(0, 300);
  } catch {
    // body wasn't JSON; keep the status-based message
  }
  if (res.status === 429 || /rate limit|quota/i.test(message)) {
    return new AiProviderError("The AI service is rate-limited right now", 429, true);
  }
  if (res.status === 401 || res.status === 403) {
    return new AiProviderError(`The AI provider rejected the API key: ${message}`, 503, false);
  }
  // 5xx (including the beta host's cold-start 503) is worth one retry; any other
  // 4xx means the request itself is wrong and will fail the same way again.
  return new AiProviderError(message, 502, res.status >= 500);
}

export const jinaProvider: AIProvider = new JinaProvider();
