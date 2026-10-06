// upstream.js — Trae CN remote-session protocol client for dsh-trae-connect.
//
// Endpoints follow the protocol Trae2api-cn documented (MIT):
//   chat   POST {REMOTE}/chat_sessions  → {chat_session_id, message_id}
//          GET  {REMOTE}/chat_sessions/{id}/events?reply_to_message_id=...
//   models GET  {REMOTE}/models?functions=solo_agent_remote&show_custom_model=true
//   credits POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage
// Auth header: `Authorization: Cloud-IDE-JWT <token>` with web-client headers
// and Origin https://solo.trae.cn.

const REMOTE_BASE = "https://trae-api-cn.mchost.guru/api/remote/v1";
const REMOTE_ORIGIN = "https://solo.trae.cn";
const CREDITS_BASE = "https://api.trae.cn";
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/**
 * Fallback roster used only when the live catalog cannot be fetched (e.g. no
 * credential yet at startup). The live catalog from
 * GET /models?functions=solo_agent_remote&show_custom_model=true replaces
 * this list as soon as it is available, and is refreshed periodically, so
 * new upstream models appear without a plugin change.
 */
export const FALLBACK_MODELS = [
	{ id: "auto", name: "Trae Auto", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "DeepSeek-V4-Flash-Official", name: "DeepSeek-V4-Flash 正式版", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "kimi-k3", name: "Kimi-K3", contextWindow: 200_000, maxTokens: 64_000 },
];

/**
 * Live model catalog state. `currentModels()` always answers synchronously
 * (the adapter builds model descriptors from it), `refreshModels(token)`
 * repopulates it from the upstream and returns the new list.
 */
let liveModels = [...FALLBACK_MODELS];
let liveFetchedAtMs = 0;
const MODEL_REFRESH_MS = 10 * 60 * 1000;

export function currentModels() {
	return liveModels;
}

function catalogModel(info) {
	// Agent-tier context windows: dev = default, max = 1M when the model
	// declares max_mode. The descriptor publishes the default window and, for
	// max-mode models, `maxContextWindow` too — the adapter swaps the effective
	// window when the card's "use maximum context window" preference is on.
	const ctx = info?.context_window_tokens ?? {};
	const contextWindow = Number(ctx.dev) > 0 ? Number(ctx.dev) : 200_000;
	const maxContextWindow = info?.max_mode === true && Number(ctx.max) > 0 ? Number(ctx.max) : undefined;
	const display = String(info?.display_name ?? info?.display_model_name ?? "").trim();
	const name = display !== "" ? display : String(info?.name ?? info?.config_name ?? "");
	// Thinking capability: the upstream declares per-model effort options
	// (light/high/extra_high) or support_thinking=false for non-thinking models.
	const effortConfig = info?.reasoning_effort_config;
	const traeEfforts = effortConfig?.support_thinking === true && Array.isArray(effortConfig.options)
		? effortConfig.options.filter((level) => typeof level === "string")
		: [];
	// Consumption rate (credit multiplier) lives inside the features JSON,
	// which arrives as either a string or an object. A missing/disabled rate
	// stays undefined — never fabricate a number.
	let traeRate;
	try {
		const feats = typeof info?.features === "string" ? JSON.parse(info.features) : info?.features;
		const rate = feats?.consumption_rate;
		if (rate?.enable === true && Number.isFinite(Number(rate?.data?.rate))) traeRate = Number(rate.data.rate);
	} catch {}
	return {
		id: String(info?.name ?? ""),
		name,
		contextWindow,
		...(maxContextWindow === undefined ? {} : { maxContextWindow }),
		...(traeEfforts.length === 0 ? {} : { traeEfforts }),
		...(traeRate === undefined ? {} : { traeRate }),
		maxTokens: 64_000,
	};
}

/** Whether a live catalog model runs in 1M max mode. */
export function isMaxModeModel(model) {
	return model?.maxContextWindow !== undefined && model.maxContextWindow > model.contextWindow;
}

/** Fetch the agent-tier catalog and replace the live roster. */
export async function refreshModels(token, signal) {
	const url = `${REMOTE_BASE}/models?functions=solo_agent_remote&show_custom_model=true`;
	const response = await fetch(url, { headers: buildHeaders(token), signal });
	if (!response.ok) throw new Error(`trae model list [${response.status}]`);
	const payload = await response.json();
	const groups = payload?.data?.list ?? [];
	const agentGroup = (Array.isArray(groups) ? groups : []).find(
		(group) => String(group?.function ?? group?.agent_type ?? "") === "solo_agent_remote",
	);
	const raw = Array.isArray(agentGroup?.models) ? agentGroup.models : [];
	const seen = new Set();
	const models = [{ id: "auto", name: "Trae Auto", contextWindow: 200_000, maxTokens: 64_000 }];
	for (const info of raw) {
		// User-configured custom models (the user's own API endpoints) never
		// carry a consumption_rate and must not be offered here. Identify them
		// by their identity flags, NOT by the absence of a rate — a future
		// official model could temporarily lack rate data.
		if (info?.is_preset === false || info?.custom_model_id != null) continue;
		const model = catalogModel(info);
		if (model.id === "" || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	if (models.length <= 1) throw new Error("trae model list returned no models");
	liveModels = models;
	liveFetchedAtMs = Date.now();
	return liveModels;
}

/** Refresh when the cached roster is older than the TTL; never throws. */
export async function refreshModelsIfStale(token, logger) {
	if (Date.now() - liveFetchedAtMs < MODEL_REFRESH_MS) return liveModels;
	try {
		return await refreshModels(token);
	} catch (error) {
		if (liveFetchedAtMs === 0) {
			logger?.warn?.(`dsh-trae-connect: live catalog unavailable, serving the fallback roster (${String(error?.message ?? error).slice(0, 160)})`);
		}
		return liveModels;
	}
}

function buildHeaders(token, { stream = false } = {}) {
	return {
		Authorization: `Cloud-IDE-JWT ${token}`,
		"Content-Type": "application/json",
		"X-Trae-Client-Type": "web",
		"X-Preferenced-Language": "zh-CN",
		"x-user-region": "CN",
		Origin: REMOTE_ORIGIN,
		Referer: `${REMOTE_ORIGIN}/`,
		"User-Agent": BROWSER_UA,
		...(stream ? { Accept: "text/event-stream" } : {}),
	};
}

function commonParams(mode, sessionId) {
	return JSON.stringify({
		language: "zh-cn",
		app_language: "zh-CN",
		quality: "stable",
		app_version: "1.0.0.1229",
		web_id: "",
		user_identity: "Free",
		is_freshman: "0",
		biz_user_id: "",
		user_unique_id: "",
		scope: "marscode-cn",
		tenant: "marscode",
		region: "cn",
		aiRegion: "cn",
		is_privacy_mode: 0,
		privacy_mode: "off",
		solo_chat_mode: mode,
		...(sessionId ? { biz_session_id: sessionId } : {}),
	});
}

/** Flatten OpenAI messages into the query payload the remote session expects. */
export function flattenQuery(messages) {
	const parts = [];
	for (const message of messages) {
		const role = message.role ?? "user";
		let content = message.content;
		if (Array.isArray(content)) {
			content = content
				.map((block) => (typeof block === "string" ? block : block?.text ?? ""))
				.join("\n");
		}
		if (content == null) content = "";
		if (role === "system") parts.push(`[System]\n${content}`);
		else if (role === "assistant") parts.push(`[Assistant]\n${content}`);
		else parts.push(content);
	}
	return JSON.stringify([{ type: "text", data: { content: parts.join("\n\n") } }]);
}

function modelSessionId(model) {
	return `dsh-trae-${model}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Remote model configs for manual selection. The upstream silently falls back
// to its default model when a manual session omits the complete model object,
// so a specific model id must resolve to its custom_model before createSession.
let modelConfigCache = undefined;
let modelConfigFetchedAt = 0;
const MODEL_CONFIG_TTL_MS = 5 * 60 * 1000;

function buildModelConfig(raw) {
	const config = { ...raw };
	if (typeof config.features === "string") {
		try { config.features = JSON.parse(config.features); } catch { config.features = {}; }
	}
	const name = config.name ?? "";
	config.config_name = config.config_name ?? name;
	config.model_name = config.model_name ?? name;
	config.config_source = config.config_source ?? 1;
	config.provider = config.provider ?? "";
	config.multimodal = Boolean(config.multimodal);
	config.ak = config.ak ?? "";
	config.sk = config.sk ?? "";
	config.base_url = config.base_url ?? "";
	config.auth_type = config.auth_type ?? 0;
	config.use_remote_service = !config.client_connect;
	return config;
}

async function fetchModelConfig(token, modelName, signal) {
	const now = Date.now();
	if (modelConfigCache === undefined || now - modelConfigFetchedAt > MODEL_CONFIG_TTL_MS) {
		const url = `${REMOTE_BASE}/models?functions=solo_agent_remote&show_custom_model=true`;
		const response = await fetch(url, { headers: buildHeaders(token), signal });
		if (!response.ok) throw new Error(`trae model list [${response.status}]`);
		const payload = await response.json();
		const configs = {};
		const groups = payload?.data?.list ?? [];
		for (const group of Array.isArray(groups) ? groups : []) {
			for (const raw of Array.isArray(group?.models) ? group.models : []) {
				const name = String(raw?.name ?? "").trim();
				if (name === "" || configs[name] !== undefined) continue;
				configs[name] = buildModelConfig(raw);
				// Case-insensitive alias so a picker id like "DeepSeek-V4.1-Flash"
				// (the display name) still resolves to config name deepseek-v4.1-flash.
				const display = String(raw?.display_name ?? "").trim();
				if (display !== "" && configs[display] === undefined) configs[display] = configs[name];
			}
		}
		modelConfigCache = configs;
		modelConfigFetchedAt = now;
	}
	const exact = modelConfigCache[modelName];
	if (exact !== undefined) return exact;
	const lowered = modelName.toLowerCase();
	for (const [name, config] of Object.entries(modelConfigCache)) {
		if (name.toLowerCase() === lowered) return config;
	}
	return undefined;
}

/** Create one remote chat session; returns {sessionId, messageId}.
 * `options.useMaximumContextWindow` pins a max-mode-capable model to its 1M
 * profile (mirrors the desktop client's max session fields). */
export async function createSession(token, model, messages, signal, options = {}) {
	const mode = "code";
	const modelName = model === "auto" ? "" : model;
	const sessionId = modelSessionId(model);
	const initialMessage = {
		chat_session_id: "",
		content: [],
		query: flattenQuery(messages),
		model_name: modelName,
		agent_type: "solo_agent_remote",
		agent_id: "solo_agent_remote",
		model_selection_strategy: model === "auto" ? "auto" : "manual",
		common_params: commonParams(mode, sessionId),
	};
	if (model !== "auto") {
		const customModel = await fetchModelConfig(token, model, signal);
		if (customModel === undefined) throw new Error(`trae model "${model}" is not available for this account`);
		initialMessage.model_name = String(customModel.config_name ?? model);
		initialMessage.custom_model = customModel;
		// Reasoning effort: the picker sends the mapped wire spelling
		// (light/high/extra_high); stamp it on the model config like the
		// desktop client does. Invalid values are dropped, not clamped —
		// the catalog decides what a model may take.
		const requestedEffort = typeof options.reasoningEffort === "string" ? options.reasoningEffort : "";
		const declared = Array.isArray(customModel?.reasoning_effort_config?.options)
			? customModel.reasoning_effort_config.options
			: [];
		if (requestedEffort !== "" && (declared.length === 0 || declared.includes(requestedEffort))) {
			initialMessage.custom_model = {
				...customModel,
				reasoning_effort_level: requestedEffort,
			};
		}
		if (options.useMaximumContextWindow === true && customModel.max_mode === true) {
			const tokens = customModel.context_window_tokens ?? {};
			const maxContext = Number(tokens.max) > 0 ? Number(tokens.max) : 1_000_000;
			const promptMax = Number(customModel.prompt_max_tokens) > 0 ? Number(customModel.prompt_max_tokens) : 936_000;
			const outputMax = Number(customModel.max_tokens) > 0 ? Number(customModel.max_tokens) : 64_000;
			initialMessage.model_auto_selection = {
				strategy: "max",
				fallback_to_advance_model: null,
				entitlement_id: null,
			};
			initialMessage.model_selection_strategy = "max";
			initialMessage.mode_type = 1;
			initialMessage.context_window_size = maxContext;
			initialMessage.prompt_max_tokens = promptMax;
			initialMessage.max_tokens = outputMax;
		}
	}
	const body = {
		mode,
		environment_id: "default",
		initial_message: initialMessage,
		env: "remote",
		auto_create_project: false,
		origin: "web",
	};
	const response = await fetch(`${REMOTE_BASE}/chat_sessions`, {
		method: "POST",
		headers: buildHeaders(token),
		body: JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`trae create_session [${response.status}]: ${text.slice(0, 400)}`);
	let payload;
	try { payload = JSON.parse(text); } catch { throw new Error(`trae create_session non-JSON: ${text.slice(0, 200)}`); }
	const data = payload?.data ?? payload ?? {};
	const chatSessionId = String(data.chat_session_id ?? "");
	const messageId = String(data.message_id ?? "");
	if (chatSessionId === "" || messageId === "") throw new Error(`trae create_session missing ids: ${text.slice(0, 200)}`);
	return { sessionId: chatSessionId, messageId };
}

/** Read one SSE frame stream; yields {event, data} objects until done. */
async function* readSse(response) {
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				line = line.replace(/\r$/, "");
				if (line.startsWith(":")) continue;
				if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
				if (line === "") { eventName = undefined; continue; }
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") return;
				let data;
				try { data = JSON.parse(payload); } catch { data = { _raw: payload }; }
				yield { event: eventName ?? String(data?.event ?? "message"), data };
				eventName = undefined;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Stream one turn: create the session, read the event stream, and yield
 * OpenAI-style deltas {type:'text'|'reasoning'|'usage'|'done', ...}.
 * `thought`/`reasoning_content` plan snapshots are cumulative; message text
 * events are snapshots too, so deltas are computed by diffing lengths.
 */
export async function* streamChat(token, model, messages, signal, options = {}) {
	const { sessionId, messageId } = await createSession(token, model, messages, signal, options);
	// Broadcast the remote session id BEFORE the event fetch: even if the
	// stream fails immediately, the consumer already holds the sessionId and
	// can clean the session up (即用即焚 delete).
	yield { type: "session", sessionId };
	const url = `${REMOTE_BASE}/chat_sessions/${sessionId}/events?reply_to_message_id=${encodeURIComponent(messageId)}`;
	const response = await fetch(url, { headers: buildHeaders(token, { stream: true }), signal });
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`trae events [${response.status}]: ${text.slice(0, 400)}`);
	}
	const thoughts = new Map();
	const contents = new Map();
	let sawTerminal = false;
	// Whether any content piece was already yielded: when the upstream closes
	// the event stream without a done frame after delivering text, the answer
	// is complete and must not be judged a failed turn.
	let emittedAny = false;
	try {
		for await (const { event, data } of readSse(response)) {
			const normalized = event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
			if (data && typeof data === "object" && (normalized === "error" || normalized === "response_error")) {
				throw new Error(`trae upstream error ${data.code ?? ""}: ${data.message ?? data.error ?? "unknown"}`);
			}
			if (normalized === "token_usage") {
				const usage = data?.usage ?? data;
				yield {
					type: "usage",
					input: Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0) || 0,
					output: Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0) || 0,
				};
				continue;
			}
			if (normalized === "plan_item") {
				const id = String(data?.id ?? "plan");
				// Remote plan snapshots grow `thought` (visible answer) and
				// `reasoning_content` (thinking) cumulatively, BUT the stream
				// also re-sends OLDER snapshots after newer ones (duplicate
				// frames out of order) and ends with a reset frame
				// (thought:"") once the answer was delivered. So: only accept
				// a snapshot that strictly extends the newest one seen; never
				// regress the stored value, and never re-emit.
				const thought = typeof data?.thought === "string" ? data.thought : "";
				const previousThought = thoughts.get(`t:${id}`) ?? "";
				if (thought.length > previousThought.length && thought.startsWith(previousThought)) {
					yield { type: "text", text: thought.slice(previousThought.length) };
					emittedAny = true;
					thoughts.set(`t:${id}`, thought);
				} else if (previousThought.length > 0 && thought.length === 0) {
					// Reset frame: the answer was already streamed; nothing to emit.
				}
				const reasoning = typeof data?.reasoning_content === "string" ? data.reasoning_content : "";
				const previousReasoning = thoughts.get(`r:${id}`) ?? "";
				if (reasoning.length > previousReasoning.length && reasoning.startsWith(previousReasoning)) {
					yield { type: "reasoning", text: reasoning.slice(previousReasoning.length) };
					emittedAny = true;
					thoughts.set(`r:${id}`, reasoning);
				}
				const content = typeof data?.content === "string" ? data.content : "";
				if (content) {
					const previous = contents.get(id) ?? "";
					if (content.length > previous.length && content.startsWith(previous)) {
						yield { type: "text", text: content.slice(previous.length) };
						emittedAny = true;
						contents.set(id, content);
					} else if (content !== previous && !content.startsWith(previous)) {
						yield { type: "text", text: content };
						emittedAny = true;
						contents.set(id, content);
					}
				}
				continue;
			}
			if (["message", "assistant_message", "response", "text", "output"].includes(normalized)) {
				const nested = data?.message ?? data?.agent_message ?? data?.assistant_message ?? data;
				let text = nested?.content;
				if (Array.isArray(text)) text = text.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("");
				if (typeof text !== "string" || text.length === 0) text = typeof nested?.response === "string" ? nested.response : "";
				if (text) {
					const previous = contents.get("__msg__") ?? "";
					if (text.length > previous.length && text.startsWith(previous)) {
						yield { type: "text", text: text.slice(previous.length) };
						emittedAny = true;
						contents.set("__msg__", text);
					} else if (text !== previous) {
						yield { type: "text", text };
						emittedAny = true;
						contents.set("__msg__", text);
					}
				}
				continue;
			}
			if (normalized === "done" || normalized === "response_done" || normalized === "stream_done") {
				sawTerminal = true;
				break;
			}
		}
	} finally {
		response.body?.cancel?.().catch?.(() => {});
	}
	if (!sawTerminal && !emittedAny) throw new Error("trae events stream ended without a done event");
	yield { type: "done" };
}

/** Fetch the account's remaining credits (entitlement usage). */
export async function fetchCredits(token) {
	const url = `${CREDITS_BASE}/trae/api/v2/pay/ide_user_ent_usage`;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Cloud-IDE-JWT ${token}`,
			"Content-Type": "application/json",
			"x-device-id": "0".repeat(16),
		},
		body: JSON.stringify({ require_usage: true, req_source: 1 }),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`trae credits [${response.status}]: ${text.slice(0, 300)}`);
	const payload = JSON.parse(text);
	return payload;
}

/** Best-effort deletion of one remote chat session (即用即焚). Fire-and-forget
 * use only: a failed delete must never fail the turn. */
export async function deleteSession(token, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return false;
	try {
		const response = await fetch(`${REMOTE_BASE}/chat_sessions/${encodeURIComponent(sessionId)}`, {
			method: "DELETE",
			headers: buildHeaders(token),
			signal: AbortSignal.timeout(15_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}
