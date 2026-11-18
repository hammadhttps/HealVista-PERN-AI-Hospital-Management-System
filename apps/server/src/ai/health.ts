import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { getProvider, isAiConfigured } from "./index.js";

/**
 * One cheap round trip to each AI endpoint at boot, logged loudly on failure.
 *
 * Every AI feature has a non-AI fallback, which is exactly why a broken provider is
 * invisible: for weeks every generation answered 422 ("model should be
 * jina-ocr-v1"), every feature quietly served its fallback, and nothing anywhere
 * said so. This check turns that into one unmissable line in the deploy log.
 *
 * Never throws and never blocks startup — the API serves requests either way.
 */
export async function checkAiProviderOnBoot(): Promise<void> {
  if (!isAiConfigured()) {
    logger.warn("[ai] JINA_API_KEY is not set — every AI feature will serve its non-AI fallback");
    return;
  }

  const provider = getProvider();

  try {
    const start = Date.now();
    const [vector] = await provider.embed(["health check"]);
    logger.info(
      { model: env.JINA_EMBED_MODEL, dims: vector.length, ms: Date.now() - start },
      "[ai] Embeddings OK",
    );
  } catch (err) {
    logger.error(
      { model: env.JINA_EMBED_MODEL, baseUrl: env.JINA_EMBED_BASE_URL, reason: errorText(err) },
      "[ai] Embeddings FAILED — semantic search will fall back to keyword search",
    );
  }

  try {
    const start = Date.now();
    await provider.generate({
      prompt: 'Reply with {"ok": true}.',
      schema: z.object({ ok: z.boolean() }),
      maxTokens: 16,
    });
    logger.info({ model: env.JINA_CHAT_MODEL, ms: Date.now() - start }, "[ai] Generation OK");
  } catch (err) {
    logger.error(
      { model: env.JINA_CHAT_MODEL, baseUrl: env.JINA_CHAT_BASE_URL, reason: errorText(err) },
      "[ai] Generation FAILED — every generative AI feature will serve its fallback",
    );
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
