import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	registerApiProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/*
 * End-to-end lifecycle regressions against the real extension factory. Rather
 * than re-implementing the message_end handler, these tests load `index.ts`,
 * register it with a fake Pi, and drive the exact provider `streamSimple` the
 * extension installs. Only the base `openai-completions` transport is
 * substituted with a controlled stream, so the tee, metadata join, capture
 * matching, persistence, and cost patching all run for real.
 */

// Hermetic + offline: no catalog, quota, or auth access during the tests.
process.env.PI_OFFLINE = "1";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(
	join(tmpdir(), "neuralwatt-lifecycle-"),
);

type Factory = (pi: ExtensionAPI) => Promise<void>;
let factory: Factory | undefined;
let factoryModulePromise: Promise<{ default: Factory }> | undefined;

beforeAll(async () => {
	factoryModulePromise ??= import("../index.ts") as Promise<{ default: Factory }>;
	factory = (await factoryModulePromise).default;
});

const SOURCE_ID = "neuralwatt-lifecycle-integration-test";
afterEach(() => {
	unregisterApiProviders(SOURCE_ID);
});

const BASE_URL = "https://api.neuralwatt.com/v1";
const encoder = new TextEncoder();
// Must match RECORD_WAIT_MS in index.ts: the metadata join bound.
const RECORD_WAIT_MS = 300;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const model = {
	id: "neuralwatt-test-model",
	name: "Neuralwatt Test",
	provider: "neuralwatt",
	api: "openai-completions",
	baseUrl: BASE_URL,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
	input: ["text"],
	reasoning: false,
} as unknown as Model<string>;

const context = {} as unknown as Context;

interface SseOptions {
	responseId?: string;
	energyKwh?: number;
	costUsd?: number;
	/** Delay the metadata comment, simulating a tail that follows `[DONE]`. */
	metadataDelayMs?: number;
	/** End the body after `[DONE]` with no metadata tail. */
	omitMetadata?: boolean;
	/** Error the metadata tee branch instead of closing it. */
	failMetadata?: boolean;
}

/** A controllable chat-completions body: one response chunk, then metadata. */
function sseBody(options: SseOptions): ReadableStream<Uint8Array> {
	let step = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (step === 0) {
				step = 1;
				const id = options.responseId ?? "resp-1";
				controller.enqueue(
					encoder.encode(
						`data: {"id":"${id}","choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n`,
					),
				);
				return;
			}
			if (step === 1) {
				step = 2;
				if (options.metadataDelayMs) await delay(options.metadataDelayMs);
				if (options.failMetadata) {
					controller.error(new Error("metadata branch failed"));
					return;
				}
				const lines: string[] = [];
				if (!options.omitMetadata) {
					if (options.energyKwh !== undefined) {
						lines.push(`: energy {"energy_kwh": ${options.energyKwh}}`);
					}
					if (options.costUsd !== undefined) {
						lines.push(`: cost {"request_cost_usd": ${options.costUsd}}`);
					}
				}
				// A body always ends after its final chunk. Enqueue and close in the
				// same pull rather than returning a no-op pull whose re-invocation
				// differs across runtimes (Node 22/24 never re-pull a filling tee
				// branch, so the body never closed and the metadata join ran to its
				// 300 ms timeout).
				if (lines.length > 0) {
					controller.enqueue(encoder.encode(`${lines.join("\n")}\n`));
				}
				controller.close();
				return;
			}
			controller.close();
		},
	});
}

function assistantMessage(
	responseId: string | undefined,
	overrides: Record<string, unknown> = {},
): unknown {
	return {
		role: "assistant",
		provider: "neuralwatt",
		model: model.id,
		responseId,
		content: [{ type: "text", text: "hello" }],
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

/*
 * Stands in for the base openai-completions transport. It calls the fetch the
 * extension wrapped (installing the tee), reads the completion id from the SDK
 * branch, then emits the same start/terminal events pi would see. It stops
 * reading the SDK branch once it has the id, so a delayed metadata tail is
 * still pending when the terminal event is produced.
 */
function createControlledBase(terminal: "done" | "error" = "done"): (
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (_model, _context, options = {}) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			let responseId: string | undefined;
			try {
				const fetchFn = options.fetch ?? globalThis.fetch;
				const response = await fetchFn(`${BASE_URL}/chat/completions`, {
					method: "POST",
				});
				const body = response.body;
				if (body) {
					const reader = body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					while (!responseId) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const match = /"id":"([^"]+)"/.exec(buffer);
						if (match) responseId = match[1];
					}
					void reader.cancel().catch(() => undefined);
				}
				const message = assistantMessage(responseId);
				stream.push({ type: "start", partial: message as never });
				if (terminal === "error") {
					stream.push({
						type: "error",
						reason: "error",
						error: assistantMessage(responseId, { stopReason: "error" }) as never,
					});
				} else {
					stream.push({ type: "done", reason: "stop", message: message as never });
				}
			} catch (error) {
				stream.push({
					type: "error",
					reason: "error",
					error: assistantMessage(undefined, {
						stopReason: "error",
						message: error instanceof Error ? error.message : String(error),
					}) as never,
				});
			} finally {
				stream.end();
			}
		})();
		return stream;
	};
}

interface Harness {
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	providers: { name: string; config: { streamSimple?: unknown } }[];
	commands: Map<string, (args: string, ctx: ExtensionContext) => unknown>;
	statuses: Map<string, string | undefined>;
	notifications: { message: string; type?: string }[];
	sessionEntries: unknown[];
	state: { branch: unknown[] };
	ctx: ExtensionContext;
}

async function createHarness(
	terminal: "done" | "error" = "done",
): Promise<Harness> {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const providers: Harness["providers"] = [];
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
	const statuses = new Map<string, string | undefined>();
	const notifications: { message: string; type?: string }[] = [];
	const sessionEntries: unknown[] = [];
	const state: { branch: unknown[] } = { branch: [] };

	const pi = {
		on: (event: string, handler: (e: unknown, c: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerProvider: (name: string, config: Harness["providers"][number]["config"]) => {
			providers.push({ name, config });
		},
		registerEntryRenderer: () => {},
		registerShortcut: () => {},
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: ExtensionContext) => unknown },
		) => {
			commands.set(name, options.handler);
		},
		appendEntry: (customType: string, data: unknown) => {
			const entry = { type: "custom", customType, data };
			sessionEntries.push(entry);
			state.branch.push(entry);
		},
	} as unknown as ExtensionAPI;

	const ui = {
		setStatus: (key: string, text: string | undefined) => {
			statuses.set(key, text);
		},
		notify: (message: string, type?: string) => {
			notifications.push({ message, type });
		},
		theme: { fg: (_color: string, text: string) => text },
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
	};

	const ctx = {
		ui,
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		sessionManager: { getBranch: () => state.branch },
		modelRegistry: { getApiKeyForProvider: async () => undefined },
		model,
		signal: undefined,
		isIdle: () => true,
	} as unknown as ExtensionContext;

	registerApiProvider(
		{
			api: "openai-completions",
			stream: createControlledBase(terminal) as never,
			streamSimple: createControlledBase(terminal) as never,
		},
		SOURCE_ID,
	);

	await factory?.(pi);
	return {
		handlers,
		providers,
		commands,
		statuses,
		notifications,
		sessionEntries,
		state,
		ctx,
	};
}

async function startSession(harness: Harness, reason = "startup"): Promise<void> {
	await harness.handlers.get("session_start")?.(
		{ type: "session_start", reason },
		harness.ctx,
	);
}

async function runResponse(
	harness: Harness,
	options: SseOptions,
): Promise<{ events: string[]; patch: unknown; elapsedMs: number }> {
	const provider = harness.providers.find((candidate) => candidate.name === "neuralwatt");
	if (!provider?.config.streamSimple) throw new Error("provider streamSimple missing");
	const streamSimple = provider.config.streamSimple as (
		m: Model<string>,
		c: Context,
		o?: SimpleStreamOptions,
	) => AssistantMessageEventStream;

	const stream = streamSimple(model, context, {
		fetch: (async () =>
			new Response(sseBody(options), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})) as never,
	});

	const events: string[] = [];
	let patch: unknown;
	const startedAt = performance.now();
	let terminalAt = startedAt;
	for await (const event of stream) {
		events.push(event.type);
		if (event.type === "done" || event.type === "error") {
			terminalAt = performance.now();
			const message = event.type === "done" ? event.message : event.error;
			// Mimic pi: message_end is emitted as soon as the terminal event
			// reaches the consumer.
			patch = await harness.handlers.get("message_end")?.(
				{ type: "message_end", message },
				harness.ctx,
			);
		}
	}
	return { events, patch, elapsedMs: terminalAt - startedAt };
}

function entriesOf(harness: Harness): Record<string, unknown>[] {
	return harness.sessionEntries.map(
		(entry) => (entry as { data: Record<string, unknown> }).data,
	);
}

function statusOf(harness: Harness): string | undefined {
	return harness.statuses.get("neuralwatt-energy");
}

describe("terminal event ordering", () => {
	it("persists late metadata by joining capture before done reaches the consumer", async () => {
		const harness = await createHarness();
		await startSession(harness);

		const { events, patch, elapsedMs } = await runResponse(harness, {
			responseId: "resp-late",
			energyKwh: 0.1,
			costUsd: 0.02,
			metadataDelayMs: 80,
		});

		expect(events).toContain("done");
		// Held for the late metadata, but only one bounded join (not ~2x).
		expect(elapsedMs).toBeGreaterThanOrEqual(40);
		expect(elapsedMs).toBeLessThan(250);
		const entries = entriesOf(harness);
		expect(entries).toHaveLength(1);
		const telemetry = entries[0];
		expect(telemetry.schemaVersion).toBe(2);
		expect(telemetry.kind).toBe("response-telemetry");
		expect(telemetry.responseId).toBe("resp-late");
		expect(telemetry.energy).toMatchObject({ status: "reported", kwh: 0.1 });
		expect(telemetry.cost).toMatchObject({ status: "reported", usd: 0.02 });
		// Reported cost is patched into pi's footer total.
		expect(
			(patch as { message: { usage: { cost: { total: number } } } }).message.usage
				.cost.total,
		).toBeCloseTo(0.02, 10);
	});

	it("holds a terminal error until metadata is joined", async () => {
		const harness = await createHarness("error");
		await startSession(harness);

		const { events, elapsedMs } = await runResponse(harness, {
			responseId: "resp-error-late",
			energyKwh: 0.5,
			metadataDelayMs: 60,
		});

		expect(events).toContain("error");
		// The error event is withheld for the metadata join rather than racing it.
		expect(elapsedMs).toBeGreaterThanOrEqual(40);
	});
});

describe("capture lifecycle", () => {
	it("records missing telemetry without failing the answer", async () => {
		const harness = await createHarness();
		await startSession(harness);

		// The body ends after [DONE] with no metadata tail, so capture completes
		// with the stream. Under fake timers the join's 300 ms fallback never
		// fires, so the terminal event must arrive from completed-capture alone.
		// If finalization waited on the timeout, this test would fail rather
		// than merely run slowly.
		vi.useFakeTimers();
		try {
			const response = runResponse(harness, {
				responseId: "resp-empty",
				omitMetadata: true,
			});
			await vi.advanceTimersByTimeAsync(0);
			let settled = false;
			void response.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			for (let i = 0; i < 10 && !settled; i++) await Promise.resolve();
			expect(settled).toBe(true);

			const { events, patch } = await response;
			expect(events).toContain("done");
			expect(patch).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
		const telemetry = entriesOf(harness)[0];
		expect(telemetry.energy).toMatchObject({ status: "missing" });
		expect(telemetry.cost).toMatchObject({ status: "missing" });
	});

	it("bounds the metadata join and records missing telemetry when metadata never arrives", async () => {
		const harness = await createHarness();
		await startSession(harness);

		// The metadata tail is delayed well past the bound. With fake timers the
		// only thing that can release the terminal event is the join's fallback,
		// so advancing exactly the bound proves the wait is capped there without
		// asserting a wall-clock duration.
		vi.useFakeTimers();
		try {
			const response = runResponse(harness, {
				responseId: "resp-slow",
				energyKwh: 0.9,
				metadataDelayMs: 600,
			});
			// Let the request reach the join so its fallback timer is armed.
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(RECORD_WAIT_MS);
			const { events } = await response;
			expect(events).toContain("done");
		} finally {
			vi.useRealTimers();
		}
		expect(entriesOf(harness)[0].energy).toMatchObject({ status: "missing" });
	});

	it("delivers the answer when the metadata branch errors", async () => {
		const harness = await createHarness();
		await startSession(harness);

		const { events, patch } = await runResponse(harness, {
			responseId: "resp-fail",
			failMetadata: true,
			metadataDelayMs: 80,
		});

		expect(events).toContain("done");
		expect(patch).toBeUndefined();
		expect(entriesOf(harness)[0].energy).toMatchObject({ status: "missing" });
	});

	it("records a completed response exactly once for a repeated response id", async () => {
		const harness = await createHarness();
		await startSession(harness);

		await runResponse(harness, { responseId: "resp-once", energyKwh: 0.1 });
		expect(entriesOf(harness)).toHaveLength(1);

		const duplicate = await harness.handlers.get("message_end")?.(
			{ type: "message_end", message: assistantMessage("resp-once") },
			harness.ctx,
		);
		expect(duplicate).toBeUndefined();
		expect(entriesOf(harness)).toHaveLength(1);
	});
});

describe("cross-provider isolation", () => {
	it("returns immediately for non-Neuralwatt and non-assistant messages", async () => {
		const harness = await createHarness();
		await startSession(harness);
		const handler = harness.handlers.get("message_end");

		const startedAt = performance.now();
		const otherProvider = await handler?.(
			{
				type: "message_end",
				message: assistantMessage(undefined, { provider: "openai" }),
			},
			harness.ctx,
		);
		const userMessage = await handler?.(
			{
				type: "message_end",
				message: { role: "user", content: "hi" },
			},
			harness.ctx,
		);
		const elapsedMs = performance.now() - startedAt;

		// No metadata wait and no cost patch for unrelated traffic.
		expect(elapsedMs).toBeLessThan(50);
		expect(otherProvider).toBeUndefined();
		expect(userMessage).toBeUndefined();
		expect(harness.sessionEntries).toHaveLength(0);
	});
});

describe("branch rebuild", () => {
	it("drops abandoned branch energy on session_tree and records the new branch only", async () => {
		const harness = await createHarness();
		await startSession(harness);

		await runResponse(harness, { responseId: "resp-e1", energyKwh: 0.1 });
		expect(statusOf(harness)).toContain("100.00 Wh");

		// Rewind above E1: the entry stays in the session file but leaves the branch.
		harness.state.branch = [];
		void harness.handlers.get("session_tree")?.(
			{ type: "session_tree", newLeafId: null, oldLeafId: "x" },
			harness.ctx,
		);
		expect(statusOf(harness)).toBe("\u26A1\uFE0F 0 Wh");

		await runResponse(harness, { responseId: "resp-e2", energyKwh: 0.2 });
		// Only the new branch's energy, not 300 Wh from adding E1 back.
		expect(statusOf(harness)).toContain("200.00 Wh");
		expect(statusOf(harness)).not.toContain("300");
		expect(harness.sessionEntries).toHaveLength(2);
	});

	it("rebuilds totals from branch entries on session_start", async () => {
		const harness = await createHarness();
		await startSession(harness);
		harness.state.branch.push({
			type: "custom",
			customType: "neuralwatt-energy-cost",
			data: {
				schemaVersion: 2,
				provider: "neuralwatt",
				kind: "response-telemetry",
				responseId: "resumed",
				modelId: model.id,
				recordedAt: "2026-01-01T00:00:00.000Z",
				energy: { status: "reported", kwh: 0.25 },
				cost: { status: "reported", usd: 0.01 },
			},
		});

		await startSession(harness, "resume");
		expect(statusOf(harness)).toContain("250.00 Wh");
	});
});

describe("energy-ui command", () => {
	it("registers neuralwatt:energy-ui without a neuralwatt:toggle alias", async () => {
		const harness = await createHarness();
		expect(harness.commands.has("neuralwatt:energy-ui")).toBe(true);
		expect(harness.commands.has("neuralwatt:toggle")).toBe(false);
	});

	it("flips visibility for the bare, on, and off arguments", async () => {
		const harness = await createHarness();
		await startSession(harness);
		const command = harness.commands.get("neuralwatt:energy-ui");
		if (!command) throw new Error("energy-ui command not registered");

		await command("off", harness.ctx);
		expect(statusOf(harness)).toBeUndefined();

		await command("on", harness.ctx);
		expect(statusOf(harness)).toBeDefined();

		// A bare argument toggles from the current state.
		await command("", harness.ctx);
		expect(statusOf(harness)).toBeUndefined();

		await command("", harness.ctx);
		expect(statusOf(harness)).toBeDefined();

		// Unknown arguments change nothing and point at the new name.
		await command("bogus", harness.ctx);
		expect(statusOf(harness)).toBeDefined();
		const usage = harness.notifications.at(-1)?.message ?? "";
		expect(usage).toContain("neuralwatt:energy-ui");
		expect(usage).not.toContain("neuralwatt:toggle");
	});
});
