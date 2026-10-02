import { describe, expect, it } from "vitest";
import { mapModelsResponse } from "../lib.ts";

const deepseekV4Pro = {
	id: "deepseek-v4-pro",
	object: "model",
	created: 0,
	owned_by: "neuralwatt",
	max_model_len: 1048560,
	metadata: {
		display_name: "DeepSeek V4-Pro",
		pricing: {
			input_per_million: 1.0,
			output_per_million: 3.0,
			cached_input_per_million: 0.1,
			cached_output_per_million: null,
			currency: "USD",
			pricing_tbd: false,
		},
		capabilities: {
			tools: true,
			json_mode: true,
			vision: false,
			reasoning: true,
			reasoning_effort: true,
			streaming: true,
			system_role: true,
			developer_role: false,
			hosted_tools: false,
		},
		limits: {
			max_context_length: 1048560,
			max_output_tokens: 393216,
			max_images: null,
		},
	},
};

describe("mapModelsResponse", () => {
	it("maps the customer catalog, keeping enrolled preview models", () => {
		const publicModel = { id: "glm-5.3", max_model_len: 131_072 };
		const out = mapModelsResponse({
			scope: "customer",
			data: [publicModel, deepseekV4Pro],
		});
		expect(out.authenticated).toBe(true);
		expect(out.models.map((m) => m.id).sort()).toEqual([
			"deepseek-v4-pro",
			"glm-5.3",
		]);
		const pro = out.models.find((m) => m.id === "deepseek-v4-pro");
		expect(pro?.name).toBe("DeepSeek V4-Pro");
		expect(pro?.reasoning).toBe(true);
		expect(pro?.contextWindow).toBe(1048560);
		expect(pro?.maxTokens).toBe(393216);
	});

	it("reports an unauthenticated public catalog", () => {
		const out = mapModelsResponse({ scope: "public", data: [{ id: "glm-5.3" }] });
		expect(out.authenticated).toBe(false);
		expect(out.models.map((m) => m.id)).toEqual(["glm-5.3"]);
	});

	it("treats a missing scope as unauthenticated", () => {
		const out = mapModelsResponse({ data: [{ id: "glm-5.3" }] });
		expect(out.authenticated).toBe(false);
	});

	it("tolerates missing data", () => {
		const out = mapModelsResponse({});
		expect(out.models).toEqual([]);
		expect(out.authenticated).toBe(false);
	});

	it("drops unusable models from the listing", () => {
		const out = mapModelsResponse({
			scope: "customer",
			data: [
				{ id: "tbd", metadata: { pricing: { pricing_tbd: true } } },
				{ id: "ok" },
			],
		});
		expect(out.models.map((m) => m.id)).toEqual(["ok"]);
	});
});
