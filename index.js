// index.js — dsh-trae-connect plugin entry.
//
// Structure mirrors dsh-workbuddy-connect: a loopback HTTP shim that speaks
// the OpenAI completions shape, a PiAiAdapter whose models point at that
// shim, and a status route for the settings card. The difference lives
// behind the shim: instead of Tencent's WorkBuddy endpoints we translate to
// Trae CN's remote-session protocol using the desktop app's decrypted
// sign-in (credentials.js + upstream.js).

import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { TraeCredentialStore } from "./credentials.js";
import { currentModels, isMaxModeModel, refreshModelsIfStale, streamChat, fetchCredits, deleteSession } from "./upstream.js";

/**
 * Live-editable settings rendered on the plugin's card (0.2.0 Config facade:
 * only `.volatile()` fields become form controls). Mirrors WorkBuddy's
 * context-window preference.
 */
export const Config = z.object({
	useMaximumContextWindow: z.boolean()
		.default(true)
		.volatile()
		.description("Use the largest context window the model declares (1M for max-mode models) when available (on by default)"),
	autoDeleteSession: z.boolean()
		.default(true)
		.volatile()
		.description("即用即焚：每轮答完删掉 Trae 侧的临时远程会话，避免刷爆它的会话列表（默认开）。删除失败不影响对话本身。"),
});

/** Read one config field tolerating both accessor and plain-value shapes. */
function readConfigValue(value) {
	if (value === null || value === undefined) return undefined;
	return typeof value.get === "function" ? value.get() : value;
}

const TRAE_PROVIDER = "trae";
const TRAE_STREAM_IDLE_TIMEOUT_MS = 300_000;
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const SHARED_SECRET = "trae-connect-local";
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20_971_520,
	requestImagePixelBudget: 4_194_304,
	requestImageMaxBytes: 1_048_576,
};

const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-trae-connect: the trae route has no pi-ai credential lifecycle");
		},
		async delete() {},
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		},
	},
};

function safeMessage(error) {
	return String(error?.message ?? error).slice(0, 300);
}

function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(payload);
}

function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, {
		error: { message, type: kind, code: kind },
	});
}

function hostIsLoopback(host) {
	const name = String(host ?? "").split(":")[0]?.replace(/^\[/, "").replace(/\]$/, "") ?? "";
	return name === "localhost" || name === "127.0.0.1" || name === "::1" || name.startsWith("127.");
}

function originIsLoopback(origin) {
	if (origin === undefined || origin === "") return true;
	try {
		return hostIsLoopback(new URL(origin).host);
	} catch {
		return false;
	}
}

/**
 * The loopback shim: an OpenAI-flavored endpoint backed by the Trae remote
 * session protocol. Binds 127.0.0.1 only, on an ephemeral port, guarded by a
 * per-process bearer secret and loopback Host/Origin checks.
 */
function createTraeShim({ store, logger, preferences }) {
	let address = undefined;
	let readyResolve;
	let readyReject;
	const ready = new Promise((res, rej) => {
		readyResolve = res;
		readyReject = rej;
	});

	const server = createServer((req, res) => {
		void handle(req, res);
	});
	server.listen(0, "127.0.0.1");
	server.once("listening", () => {
		address = server.address();
		readyResolve();
	});
	server.once("error", (error) => readyReject(error));

	function bearerOk(req) {
		const header = req.headers.authorization ?? "";
		const match = /^Bearer\s+(.+)$/.exec(header);
		return match !== null && match[1] === SHARED_SECRET;
	}

	async function handle(req, res) {
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: currentModels().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "trae",
					})),
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", safeMessage(error));
			else res.end();
		}
	}

	async function readBody(req) {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		return Buffer.concat(chunks).toString("utf8");
	}

	async function chatCompletions(req, res) {
		const contentType = String(req.headers["content-type"] ?? "");
		if (!contentType.includes("application/json")) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		let auth;
		try {
			auth = await store.resolve();
		} catch (error) {
			writeOpenAIError(res, 401, "not_signed_in", safeMessage(error));
			return;
		}
		let body;
		try {
			body = JSON.parse(await readBody(req));
		} catch (error) {
			writeOpenAIError(res, 400, "invalid_request", `invalid JSON body: ${safeMessage(error)}`);
			return;
		}
		const model = String(body.model ?? "auto");
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const stream = body.stream === true;
		const controller = new AbortController();
		req.on("close", () => controller.abort());

		try {
			if (stream) {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
				});
				const completionId = `chatcmpl-trae-${Date.now().toString(36)}`;
				const sendChunk = (delta, finishReason, usage) => {
					const chunk = {
						id: completionId,
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model,
						choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
						...(usage === undefined ? {} : { usage }),
					};
					res.write(`data: ${JSON.stringify(chunk)}\n\n`);
				};
				sendChunk({ role: "assistant" });
				let usage;
				const sessionOptions = {
					useMaximumContextWindow: preferences.useMaximumContextWindow() === true,
					...(typeof body.reasoning_effort === "string" && body.reasoning_effort !== "" ? { reasoningEffort: body.reasoning_effort } : {}),
				};
				let textTotal = 0;
				let failed;
				let sessionId;
				try {
					for await (const piece of streamChat(auth.token, model, messages, controller.signal, sessionOptions)) {
						if (piece.type === "text") { textTotal += piece.text.length; sendChunk({ content: piece.text }); }
						else if (piece.type === "reasoning") sendChunk({ reasoning_content: piece.text });
						else if (piece.type === "usage") usage = piece;
						else if (piece.type === "session") sessionId = piece.sessionId;
					}
				} catch (error) {
					failed = error;
				}
				// 即用即焚 cleanup: whenever a remote session was created, delete
				// it after the turn — regardless of success, failure, or abort.
				// Fire-and-forget, and always BEFORE the failed/early-return path
				// below so a zero-byte failed stream still cleans up.
				if (preferences.autoDeleteSession() === true && sessionId !== undefined) {
					void deleteSession(auth.token, sessionId).catch(() => {});
				}
				if (failed !== undefined && textTotal === 0 && !controller.signal.aborted) {
					// SSE headers already went out with the writeHead above, so a
					// second writeHead inside writeOpenAIError would throw
					// ERR_HTTP_HEADERS_SENT; end quietly instead of leaving a
					// stream without any finish frame.
					res.end();
					return;
				}
				sendChunk({}, "stop", usage === undefined ? undefined : {
					prompt_tokens: usage.input,
					completion_tokens: usage.output,
					total_tokens: usage.input + usage.output,
				});
				res.write("data: [DONE]\n\n");
				res.end();
			} else {
				let content = "";
				let reasoning = "";
				let usage;
				let sessionId;
				const sessionOptions = {
					useMaximumContextWindow: preferences.useMaximumContextWindow() === true,
					...(typeof body.reasoning_effort === "string" && body.reasoning_effort !== "" ? { reasoningEffort: body.reasoning_effort } : {}),
				};
				for await (const piece of streamChat(auth.token, model, messages, controller.signal, sessionOptions)) {
					if (piece.type === "text") content += piece.text;
					else if (piece.type === "reasoning") reasoning += piece.text;
					else if (piece.type === "usage") usage = piece;
					else if (piece.type === "session") sessionId = piece.sessionId;
				}
				// 即用即焚 cleanup, same fire-and-forget as the streaming branch.
				if (preferences.autoDeleteSession() === true && sessionId !== undefined) {
					void deleteSession(auth.token, sessionId).catch(() => {});
				}
				writeJson(res, 200, {
					id: `chatcmpl-trae-${Date.now().toString(36)}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model,
					choices: [{
						index: 0,
						message: {
							role: "assistant",
							content,
							...(reasoning === "" ? {} : { reasoning_content: reasoning }),
						},
						finish_reason: "stop",
					}],
					usage: usage === undefined ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } : {
						prompt_tokens: usage.input,
						completion_tokens: usage.output,
						total_tokens: usage.input + usage.output,
					},
				});
			}
		} catch (error) {
			if (!res.headersSent) {
				writeOpenAIError(res, 502, "upstream_error", `trae upstream: ${safeMessage(error)}`);
			} else {
				try { res.end(); } catch {}
			}
		}
	}

	return {
		ready,
		baseUrl: () => (address === undefined ? "" : `http://127.0.0.1:${address.port}`),
		token: () => SHARED_SECRET,
		close: () => new Promise((resolveClose, rejectClose) => {
			server.close(() => resolveClose());
			server.closeAllConnections();
			server.once("error", rejectClose);
		}),
	};
}

/**
 * Map DSH picker levels onto the model's declared Trae effort options
 * (light / high / extra_high), mirroring dsh-workbuddy-connect's
 * thinkingLevelMap: a DSH level maps to the wire spelling only when the
 * model declares it; everything else is null (not offered).
 */
function thinkingLevelMapFor(traeEfforts) {
	const has = (level) => traeEfforts.includes(level) ? level : null;
	const light = has("light");
	const high = has("high");
	const extra = has("extra_high");
	return {
		off: null,
		minimal: light,
		low: light,
		medium: high,
		high: high,
		xhigh: extra,
		max: extra,
	};
}

function toPiModel(info, baseUrl, useMaximumContextWindow) {
	const useMax = useMaximumContextWindow === true && isMaxModeModel(info);
	const efforts = Array.isArray(info.traeEfforts) ? info.traeEfforts : [];
	// Price display mirrors dsh-qoder-connect / dsh-workbuddy-connect: a zero
	// rate means free, other rates show as a multiplier. Models without a
	// declared consumption_rate (experimental slots) get no suffix.
	const priceSuffix = info.traeRate === undefined || info.traeRate === null
		? ""
		: info.traeRate === 0 ? " · 免费" : ` · x${info.traeRate}`;
	return {
		id: info.id,
		name: `${info.name}${priceSuffix}`,
		api: "openai-completions",
		provider: TRAE_PROVIDER,
		baseUrl,
		input: ["text"],
		...(efforts.length === 0
			? { reasoning: false }
			: { reasoning: true, thinkingLevelMap: thinkingLevelMapFor(efforts) }),
		cost: NO_COST,
		contextWindow: useMax ? info.maxContextWindow : info.contextWindow,
		maxTokens: info.maxTokens,
		compat: { maxTokensField: "max_tokens", supportsReasoningEffort: true, thinkingFormat: "openai" },
	};
}

function createTraeAdapter({ shim, store, logger, preferences }) {
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		const useMaximumContextWindow = preferences.useMaximumContextWindow() === true;
		return currentModels().map((info) => toPiModel(info, baseUrl, useMaximumContextWindow));
	};
	const provider = {
		...createProvider({
			id: TRAE_PROVIDER,
			name: "Trae",
			auth: { apiKey: {
				name: "Trae Cloud-IDE-JWT bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === undefined || apiKey.length === 0 ? undefined : {
						auth: { apiKey },
						source: "Trae",
					};
				},
			} },
			models: buildModels(),
			api: openAICompletionsApi(),
		}),
		getModels: () => buildModels(),
	};
	const profile = {
		provider: TRAE_PROVIDER,
		displayName: "Trae",
		streamIdleTimeoutMs: TRAE_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(undefined, "dsh-trae-connect retryPolicy"),
		configuredMaxTokens: new Map(),
		modelErrors: new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider,
	};
	const profiles = new Map([[TRAE_PROVIDER, profile]]);
	const adapter = new PiAiAdapter({
		profiles: () => profiles,
		auth: INERT_AUTH,
		resolveApiKey: async () => shim.token(),
	});
	return {
		adapter,
		// A catalog refresh rebuilds the snapshot so listModels/resolveModel
		// pick up the new roster, exactly like a WorkBuddy catalog update.
		invalidate: () => {
			profiles.set(TRAE_PROVIDER, { ...profile });
		},
	};
}

async function traeWebStatus({ store }) {
	const authStatus = await store.status();
	if (authStatus.state !== "signed-in") return { status: "signed-out", ...authStatus };
	const status = { status: "signed-in", ...authStatus };
	try {
		const auth = await store.resolve();
		const credits = await fetchCredits(auth.token);
		return { ...status, credits };
	} catch (error) {
		return { ...status, creditsError: safeMessage(error) };
	}
}

export async function apply(ctx, config) {
	const logger = ctx.logger;
	/** Live preference read; tolerates accessor and plain-value shapes. */
	const preferences = {
		useMaximumContextWindow: () => readConfigValue(config?.useMaximumContextWindow) === true,
		autoDeleteSession: () => readConfigValue(config?.autoDeleteSession) !== false,
	};
	const store = new TraeCredentialStore({
		path: resolve(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".trae-connect", "credentials.json")),
		logger,
	});
	const shim = createTraeShim({ store, logger, preferences });
	try {
		await shim.ready;
	} catch (error) {
		logger.error("dsh-trae-connect: Trae loopback endpoint failed to start", error);
		return;
	}
	try {
		const trae = createTraeAdapter({ shim, store, logger, preferences });
		const releaseAdapter = ctx.llm.registerAdapter([TRAE_PROVIDER], trae.adapter);
		try {
			ctx.effect(() => () => {
				releaseAdapter();
				shim.close();
			});
		} catch {
			releaseAdapter();
			shim.close();
		}
		// A live settings edit republishes the descriptors so the context-window
		// preference takes effect on the next request without a restart.
		try {
			ctx.on("loader/volatile-update", () => {
				trae.invalidate();
				ctx.emit?.("llm/adapters-updated");
			});
		} catch {
			// Hosts without the event keep restart-required semantics for edits.
		}
		// Settings-card status route (loopback-only, same guard as the shim).
		try {
			ctx.effect(() => {
				const dispose = ctx.webServer.register({
					kind: "exact",
					path: "/plugins/dsh-trae-connect/status",
					handler: async (req, res) => {
						if (req.method !== "GET") {
							writeJson(res, 405, { error: "method not allowed" });
							return;
						}
						if (!(hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin))) {
							writeJson(res, 403, { error: "request-not-trusted" });
							return;
						}
						try {
							writeJson(res, 200, await traeWebStatus({ store }));
						} catch (error) {
							writeJson(res, 500, { error: safeMessage(error) });
						}
					},
				});
				return () => dispose();
			}, "dsh-trae-connect: Web status route");
		} catch {
			// Older hosts without webServer registration keep working without the card.
		}
		// Startup: resolve the credential, pull the LIVE model roster, then
		// publish it into the adapter so the picker shows every model the
		// account actually has (not the fallback subset). Repeated on a timer.
		const syncCatalog = async () => {
			try {
				const auth = await store.resolve();
				const previousIds = new Set(currentModels().map((model) => model.id));
				const models = await refreshModelsIfStale(auth.token, logger);
				const changed = models.length !== previousIds.size || models.some((model) => !previousIds.has(model.id));
				logger.info?.(`dsh-trae-connect: catalog ${models.length} models (user ${auth.userId ?? "unknown"})${changed ? " — updated" : ""}`);
				if (changed) trae.invalidate();
			} catch (error) {
				logger.warn?.(`dsh-trae-connect: catalog sync failed (${safeMessage(error)}); serving the fallback roster`);
			}
		};
		void syncCatalog();
		const catalogTimer = setInterval(() => void syncCatalog(), 10 * 60 * 1000);
		catalogTimer.unref?.();
		try {
			ctx.effect(() => () => clearInterval(catalogTimer));
		} catch {
			clearInterval(catalogTimer);
		}
	} catch (error) {
		logger.error("dsh-trae-connect: Trae provider registration failed", error);
		shim.close();
	}
}

export const name = "dsh-trae-connect";
export const inject = ["llm"];
export { createTraeShim };
