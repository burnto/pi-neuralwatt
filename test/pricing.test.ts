import { describe, expect, it } from "vitest";
import {
	type NeuralwattApiModel,
	asPrice,
	buildThinkingLevelMap,
	mapApiModel,
} from "../lib.ts";

/*
 * Sanitized from the live public catalog (GET /v1/models, scope "public").
 * The reasoning contract is the shape this extension maps onto Pi's
 * ThinkingLevelMap; keep it as a recorded fixture rather than a live call.
 */
const reasoningMetadata: NonNullable<NeuralwattApiModel["metadata"]>["reasoning"] = {
	mandatory: false,
	default_enabled: true,
	supported_efforts: ["xhigh", "medium", "low", "none"],
	default_effort: "xhigh",
	accepted_efforts: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
	effort_aliases: { max: "xhigh", high: "xhigh", minimal: "low" },
};

describe("asPrice", () => {
	it("returns positive finite numbers and coerces the rest to 0", () => {
		expect(asPrice(1.5)).toBe(1.5);
		expect(asPrice(0)).toBe(0);
		expect(asPrice(-1)).toBe(0);
		expect(asPrice(NaN)).toBe(0);
		expect(asPrice(Infinity)).toBe(0);
		expect(asPrice(null)).toBe(0);
		expect(asPrice("3")).toBe(0);
	});
});

describe("buildThinkingLevelMap", () => {
	it("returns undefined when the model does not reason", () => {
		expect(buildThinkingLevelMap({ id: "x" })).toBeUndefined();
		expect(
			buildThinkingLevelMap({
				id: "x",
				metadata: { capabilities: { reasoning: false } },
			}),
		).toBeUndefined();
	});

	it("maps supported and aliased efforts without disabling low/medium", () => {
		const out = buildThinkingLevelMap({
			id: "qwen-3.8-27b",
			metadata: {
				capabilities: { reasoning: true, reasoning_effort: true },
				reasoning: reasoningMetadata,
			},
		});
		expect(out).toEqual({
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "xhigh",
			xhigh: "xhigh",
			max: "xhigh",
			off: "none",
		});
	});

	it("cannot disable a mandatory reasoning model", () => {
		const out = buildThinkingLevelMap({
			id: "always",
			metadata: {
				capabilities: { reasoning: true, reasoning_effort: true },
				reasoning: { ...reasoningMetadata, mandatory: true },
			},
		});
		expect(out?.off).toBeNull();
	});

	it("disables levels the model does not support", () => {
		const out = buildThinkingLevelMap({
			id: "medium-only",
			metadata: {
				capabilities: { reasoning: true, reasoning_effort: true },
				reasoning: {
					supported_efforts: ["medium"],
					accepted_efforts: ["medium"],
				},
			},
		});
		expect(out).toEqual({
			minimal: null,
			low: null,
			medium: "medium",
			high: null,
			xhigh: null,
			max: null,
			off: null,
		});
	});

	it("uses a conservative fallback when metadata.reasoning is absent", () => {
		expect(
			buildThinkingLevelMap({
				id: "old-effort",
				metadata: { capabilities: { reasoning: true, reasoning_effort: true } },
			}),
		).toEqual({ off: "none", high: "high", xhigh: "max" });
		expect(
			buildThinkingLevelMap({
				id: "old-no-effort",
				metadata: { capabilities: { reasoning: true } },
			}),
		).toEqual({
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: null,
		});
	});
});

describe("mapApiModel", () => {
	it("returns null for deprecated or price-TBD models", () => {
		expect(mapApiModel({ id: "old", metadata: { deprecated: true } })).toBeNull();
		expect(
			mapApiModel({ id: "tbd", metadata: { pricing: { pricing_tbd: true } } }),
		).toBeNull();
	});

	it("maps a basic text model with defaults", () => {
		const out = mapApiModel({ id: "nw-text", metadata: { display_name: "Text" } });
		expect(out).toMatchObject({
			id: "nw-text",
			name: "Text",
			reasoning: false,
			input: ["text"],
			contextWindow: 131_072,
			maxTokens: 65_536,
		});
		expect(out?.compat.maxTokensField).toBe("max_tokens");
		expect(out?.compat.supportsDeveloperRole).toBe(false);
	});

	it("sets reasoning compat and keeps effective pricing as published", () => {
		const out = mapApiModel({
			id: "qwen",
			max_model_len: 262_128,
			metadata: {
				display_name: "Qwen",
				capabilities: { reasoning: true, reasoning_effort: true, vision: true },
				reasoning: reasoningMetadata,
				pricing: {
					input_per_million: 0.45,
					output_per_million: 3.2,
					cached_input_per_million: 0.25,
					cached_output_per_million: null,
				},
				limits: { max_context_length: 262_128, max_output_tokens: 131_072 },
			},
		});
		expect(out?.reasoning).toBe(true);
		expect(out?.compat.supportsReasoningEffort).toBe(true);
		expect(out?.compat.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect(out?.input).toEqual(["text", "image"]);
		expect(out?.cost).toEqual({
			input: 0.45,
			output: 3.2,
			cacheRead: 0.25,
			cacheWrite: 0,
		});
		expect(out?.contextWindow).toBe(262_128);
		expect(out?.maxTokens).toBe(131_072);
	});

	it("does not enable reasoning effort when the capability is absent", () => {
		const out = mapApiModel({
			id: "nw-reason",
			metadata: { capabilities: { reasoning: true } },
		});
		expect(out?.compat.supportsReasoningEffort).toBeUndefined();
	});
});
