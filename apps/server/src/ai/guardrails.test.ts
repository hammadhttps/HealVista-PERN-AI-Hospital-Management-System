import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { AiGenerationError, generateValidated } from "./guardrails.js";
import { exampleFor, extractJson, unwrapEchoedSchema } from "./jina.provider.js";
import { AiProviderError } from "./ai.provider.js";
import type { AIProvider } from "./ai.provider.js";

vi.mock("../config/env.js", () => ({
  env: {
    JINA_API_KEY: "test-key",
    JINA_CHAT_MODEL: "jina-vlm",
    JINA_EMBED_MODEL: "jina-embeddings-v5-text-small",
  },
}));

const testSchema = z.object({
  summary: z.string(),
  flags: z.array(z.string()),
});

function mockProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    embed: vi.fn().mockResolvedValue([]),
    generate: vi.fn(),
    transcribe: vi.fn(),
    lastUsage: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

describe("generateValidated", () => {
  it("returns Zod-validated output from the provider", async () => {
    const provider = mockProvider({
      generate: vi.fn().mockResolvedValue({ summary: "ok", flags: ["a"] }),
    });
    const result = await generateValidated(provider, {
      feature: "test",
      prompt: "p",
      schema: testSchema,
    });
    expect(result).toEqual({ summary: "ok", flags: ["a"] });
  });

  it("retries once on malformed JSON, then succeeds", async () => {
    const provider = mockProvider({
      generate: vi
        .fn()
        .mockRejectedValueOnce(new Error("Unexpected token < in JSON at position 0"))
        .mockResolvedValueOnce({ summary: "recovered", flags: [] }),
    });
    const result = await generateValidated(provider, {
      feature: "test",
      prompt: "p",
      schema: testSchema,
    });
    expect(result).toEqual({ summary: "recovered", flags: [] });
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });

  it("throws AiGenerationError when output fails Zod validation on every attempt", async () => {
    const provider = mockProvider({
      generate: vi.fn().mockResolvedValue({ summary: 42 }),
    });
    await expect(
      generateValidated(provider, { feature: "test", prompt: "p", schema: testSchema }),
    ).rejects.toBeInstanceOf(AiGenerationError);
  });

  it("does not retry when the provider is simply not configured (503)", async () => {
    const provider = mockProvider({
      generate: vi.fn().mockRejectedValue(new AiGenerationError("not configured", 503)),
    });
    await expect(
      generateValidated(provider, { feature: "test", prompt: "p", schema: testSchema }),
    ).rejects.toBeInstanceOf(AiGenerationError);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("does not retry a safety-declined generation (422)", async () => {
    const provider = mockProvider({
      generate: vi.fn().mockRejectedValue(new AiGenerationError("declined", 422)),
    });
    await expect(
      generateValidated(provider, { feature: "test", prompt: "p", schema: testSchema }),
    ).rejects.toBeInstanceOf(AiGenerationError);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
});

describe("generateValidated retry policy", () => {
  it("feeds the validation errors back to the model on the retry", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ summary: "x" }) // missing `flags`
      .mockResolvedValueOnce({ summary: "x", flags: [] });
    const provider = mockProvider({ generate });

    await generateValidated(provider, { feature: "test", prompt: "base", schema: testSchema });

    expect(generate).toHaveBeenCalledTimes(2);
    const retryPrompt = (generate.mock.calls[1][0] as { prompt: string }).prompt;
    expect(retryPrompt).toContain("base");
    expect(retryPrompt).toContain("flags");
  });

  it("does not retry a request the provider rejects as invalid", async () => {
    const provider = mockProvider({
      generate: vi
        .fn()
        .mockRejectedValue(new AiProviderError("Input should be 'jina-ocr-v1'", 502, false)),
    });
    await expect(
      generateValidated(provider, { feature: "test", prompt: "p", schema: testSchema }),
    ).rejects.toBeInstanceOf(AiGenerationError);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("retries a transient provider failure", async () => {
    const provider = mockProvider({
      generate: vi
        .fn()
        .mockRejectedValueOnce(new AiProviderError("cold start", 502, true))
        .mockResolvedValueOnce({ summary: "ok", flags: [] }),
    });
    const result = await generateValidated(provider, {
      feature: "test",
      prompt: "p",
      schema: testSchema,
    });
    expect(result.summary).toBe("ok");
  });
});

describe("output shaping for jina-vlm", () => {
  it("describes the expected output as a fillable example, not a JSON Schema", () => {
    const example = exampleFor(
      z.object({
        answer: z.string(),
        level: z.enum(["LOW", "HIGH"]).nullable(),
        days: z.number(),
        tags: z.array(z.string()),
      }),
    );
    expect(example).toEqual({
      answer: "<string>",
      level: "<one of: LOW | HIGH> or null",
      days: 0,
      tags: ["<string>"],
    });
  });

  it("unwraps a reply that echoed a schema wrapper around the real answer", () => {
    const schema = z.object({ intervalDays: z.number(), rationale: z.string() });
    const echoed = { type: "object", properties: { intervalDays: 5, rationale: "r" } };
    expect(unwrapEchoedSchema(echoed, schema)).toEqual({ intervalDays: 5, rationale: "r" });
  });

  it("leaves a legitimate payload untouched", () => {
    const schema = z.object({ properties: z.array(z.string()) });
    const value = { properties: ["a"] };
    expect(unwrapEchoedSchema(value, schema)).toBe(value);
  });

  it("extracts the object from fenced or prose-trailed replies", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson(' {"a":"}"}\n\nExtracted Text: more')).toBe('{"a":"}"}');
    expect(extractJson('Sure! {"a":[1,2]} hope that helps')).toBe('{"a":[1,2]}');
  });
});
