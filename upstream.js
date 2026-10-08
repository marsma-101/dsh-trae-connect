// upstream.js — Trae remote-session protocol client for dsh-trae-connect.
//
// Endpoints follow the protocol Trae2api-cn documented (MIT) for the CN
// edition:
//   chat   POST {REMOTE}/chat_sessions  → {chat_session_id, message_id}
//          GET  {REMOTE}/chat_sessions/{id}/events?reply_to_message_id=...
//   models GET  {REMOTE}/models?functions=solo_agent_remote&show_custom_model=true
//   credits POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage
// Auth header: `Authorization: Cloud-IDE-JWT <token>` with web-client headers
// and Origin https://solo.trae.cn.
//
// International edition (live-verified 2026-10-08 against a real account):
// remote gate `https://core-normal.trae.ai/api/remote/v1` — host taken from
// the app's own product.json `remote.trae` section (SG/US mirror
// coresg-normal.trae.ai serves the same path with the same effect), web
// origin `https://work.trae.ai` (product.json soloUrl, used as Origin/
// Referer). The credential record's own host (growsg-normal.trae.ai) is the
// AUTH domain, NOT the remote gate — never use it as remoteBase.
// Auth requires BOTH headers at once: `Cloud-IDE-JWT: <token>` AND
// `Authorization: Cloud-IDE-JWT <token>`; either one alone returns 401.
// The intl models payload nests the roster one level deeper than CN:
// `{code:0, data:{list:[{function:"solo_agent_remote", models:[…]}]}}` vs
// the CN `{data:[…]}` — the parser accepts both shapes.

const REMOTE_BASE = "https://trae-api-cn.mchost.guru/api/remote/v1";
const REMOTE_ORIGIN = "https://solo.trae.cn";
const CREDITS_BASE = "https://api.trae.cn";
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/**
 * Per-edition remote-session endpoints. intl defaults are live-verified
 * (2026-10-08); a Config-card / environment override still wins over them.
 */
const REMOTE_ENV = {
	cn: {
		remoteBase: REMOTE_BASE,
		webOrigin: REMOTE_ORIGIN,
		userRegion: "CN",
		language: "zh-cn",
		scope: "marscode-cn",
		tenant: "marscode",
		region: "cn",
	},
	intl: {
		remoteBase: "https://core-normal.trae.ai/api/remote/v1",
		webOrigin: "https://work.trae.ai",
		userRegion: "SG",
		language: "en",
		scope: "marscode",
		tenant: "marscode",
		region: "sg",
	},
};

/**
 * Effective endpoints for one edition, after Config-card / environment
 * overrides. Never throws; callers check `remoteBase !== ""` before use.
 */
export function remoteEndpointsFor(edition, overrides = {}) {
	const base = REMOTE_ENV[edition] ?? REMOTE_ENV.cn;
	const overrideRemote = String(overrides.remoteBase ?? "").trim().replace(/\/+$/, "");
	const overrideOrigin = String(overrides.webOrigin ?? "").trim().replace(/\/+$/, "");
	return {
		...base,
		remoteBase: overrideRemote !== "" ? overrideRemote : base.remoteBase,
		webOrigin: overrideOrigin !== "" ? overrideOrigin : base.webOrigin,
	};
}

/** Whether the environment overrides came from the process environment. */
export function environmentOverrides() {
	return {
		remoteBase: process.env.TRAE_INTL_REMOTE_BASE ?? "",
		webOrigin: process.env.TRAE_INTL_WEB_ORIGIN ?? "",
	};
}

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
 * Live model catalog state, per edition. `currentModels(edition)` always
 * answers synchronously (the adapter builds model descriptors from it),
 * `refreshModels(token, signal, edition)` repopulates that edition's roster
 * from the upstream and returns the new list.
 */
const liveModelsByEdition = { cn: [...FALLBACK_MODELS], intl: [...FALLBACK_MODELS] };
const liveFetchedAtByEdition = { cn: 0, intl: 0 };
const MODEL_REFRESH_MS = 10 * 60 * 1000;

/**
 * Placeholder roster for an edition that never successfully fetched a live
 * catalog (e.g. intl without a configured/verified upstream). Same shape the
 * adapter used for the "intl installed but unconfigured" card state, kept in
 * one place so the two call sites cannot drift.
 */
export const INTL_PLACEHOLDER_MODELS = [
	{ id: "auto", name: "Trae Auto（未配置上游）", contextWindow: 200_000, maxTokens: 64_000 },
];

export function currentModels(edition = "cn") {
	// A live roster is only trusted after THIS edition actually fetched one.
	// An edition that never pulled a catalog must not silently inherit
	// another edition's roster (intl once leaked the CN list this way); the
	// static CN fallback table stays CN-only, and every other unfetched
	// edition gets the single placeholder.
	if (liveFetchedAtByEdition[edition] > 0) return liveModelsByEdition[edition];
	return edition === "cn" ? liveModelsByEdition.cn : INTL_PLACEHOLDER_MODELS;
}

/**
 * Discard one edition's live catalog (account switch / sign-out): the roster
 * falls back to the static table and "never fetched" semantics, so nothing
 * from the departing account is served while the next one is being pulled.
 */
export function resetLiveModels(edition = "cn") {
	liveModelsByEdition[edition] = [...FALLBACK_MODELS];
	liveFetchedAtByEdition[edition] = 0;
}

function catalogModel(info) {
	// Agent-tier context windows: dev = default, max = 1M when the model
	// declares max_mode. The descriptor publishes the default window and, for
	// max-mode models, `maxContextWindow` too — the adapter swaps the effective
	// window when the card's "use maximum context window" preference is on.
	const ctx = info?.context_window_tokens ?? {};
	// Live intl observation (2026-10-08): max may be 0, meaning the model has
	// no max tier at all — fall back to dev instead of publishing 0.
	const devWindow = Number(ctx.dev) > 0 ? Number(ctx.dev) : 200_000;
	const contextWindow = devWindow;
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
	// which arrives as either a string or an object. CN declares
	// `consumption_rate.data.rate`; intl (live-verified 2026-10-08) declares
	// `cost.data.manual_usage` instead. A missing/disabled rate stays
	// undefined — never fabricate a number.
	let traeRate;
	try {
		const feats = typeof info?.features === "string" ? JSON.parse(info.features) : info?.features;
		const cnRate = feats?.consumption_rate;
		if (cnRate?.enable === true && Number.isFinite(Number(cnRate?.data?.rate))) traeRate = Number(cnRate.data.rate);
		if (traeRate === undefined && Number.isFinite(Number(feats?.cost?.data?.manual_usage))) {
			traeRate = Number(feats.cost.data.manual_usage);
		}
	} catch {}
	return {
		id: String(info?.name ?? ""),
		name,
		contextWindow,
		...(maxContextWindow === undefined ? {} : { maxContextWindow }),
		...(traeEfforts.length === 0 ? {} : { traeEfforts }),
		...(traeRate === undefined ? {} : { traeRate }),
		maxTokens: 64_000,
		// Raw identity flags kept on the descriptor so createSession can build
		// the custom_model object verbatim for manual sessions.
		rawInfo: info,
	};
}

/** Whether a live catalog model runs in 1M max mode. */
export function isMaxModeModel(model) {
	return model?.maxContextWindow !== undefined && model.maxContextWindow > model.contextWindow;
}

/** Parse the model-list payload into a filtered roster (no side effects).
 * Two verified payload shapes are accepted:
 *   CN: `{data:[…models…]}` — the data field IS the model array;
 *   intl (2026-10-08): `{code:0, data:{list:[{function:"solo_agent_remote",
 *   models:[…]}]}}` — the roster hides in data.list[].models, and the
 *   solo_agent_remote entry wins when several function groups come back. */
function parseModelList(payload) {
	const data = payload?.data;
	let raw;
	if (Array.isArray(data)) {
		raw = data;
	} else {
		const groups = data?.list ?? [];
		const list = Array.isArray(groups) ? groups : [];
		// Prefer the solo_agent_remote group; fall back to the first group
		// that actually carries models.
		const agentGroup = list.find(
			(group) => String(group?.function ?? group?.agent_type ?? "") === "solo_agent_remote",
		) ?? list.find((group) => Array.isArray(group?.models) && group.models.length > 0);
		raw = Array.isArray(agentGroup?.models) ? agentGroup.models : [];
	}
	const seen = new Set();
	const models = [{ id: "auto", name: "Trae Auto", contextWindow: 200_000, maxTokens: 64_000 }];
	for (const info of raw) {
		// User-configured custom models (the user's own API endpoints) never
		// carry a consumption_rate and must not be offered here. Identify them
		// by their identity flags, NOT by the absence of a rate — a future
		// official model could temporarily lack rate data.
		if (info?.is_preset === false || info?.custom_model_id != null || Number(info?.config_source) === 3) continue;
		const model = catalogModel(info);
		if (model.id === "" || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

/** Fetch the agent-tier catalog and replace the live roster for one edition. */
export async function refreshModels(token, signal, edition = "cn", overrides) {
	const endpoints = remoteEndpointsFor(edition, overrides);
	if (endpoints.remoteBase === "") {
		throw new Error(`trae model list: 未配置 ${edition === "intl" ? "国际版" : "国内版"} 上游地址`);
	}
	const url = `${endpoints.remoteBase}/models?functions=solo_agent_remote&show_custom_model=true`;
	const response = await fetch(url, { headers: buildHeaders(token, edition, {}, endpoints), signal });
	if (!response.ok) throw new Error(`trae model list [${response.status}]`);
	const payload = await response.json();
	const models = parseModelList(payload);
	if (models.length <= 1) throw new Error("trae model list returned no models");
	liveModelsByEdition[edition] = models;
	liveFetchedAtByEdition[edition] = Date.now();
	return liveModelsByEdition[edition];
}

/** Refresh when the cached roster is older than the TTL; never throws. */
export async function refreshModelsIfStale(token, logger, edition = "cn", overrides) {
	if (Date.now() - liveFetchedAtByEdition[edition] < MODEL_REFRESH_MS) return currentModels(edition);
	try {
		return await refreshModels(token, undefined, edition, overrides);
	} catch (error) {
		if (liveFetchedAtByEdition[edition] === 0) {
			logger?.warn?.(`dsh-trae-connect: live catalog unavailable, serving the fallback roster (${String(error?.message ?? error).slice(0, 160)})`);
		}
		return currentModels(edition);
	}
}

function buildHeaders(token, edition, { stream = false } = {}, endpoints) {
	const env = endpoints ?? remoteEndpointsFor(edition);
	return {
		Authorization: `Cloud-IDE-JWT ${token}`,
		// intl (live-verified 2026-10-08) requires BOTH auth headers at once —
		// either one alone returns 401. CN keeps the single header it always
		// used (zero regression).
		...(edition === "intl" ? { "Cloud-IDE-JWT": token } : {}),
		"Content-Type": "application/json",
		"X-Trae-Client-Type": "web",
		"X-Preferenced-Language": edition === "intl" ? "en-US" : "zh-CN",
		"x-user-region": env.userRegion,
		Origin: env.webOrigin,
		Referer: `${env.webOrigin}/`,
		"User-Agent": BROWSER_UA,
		...(stream ? { Accept: "text/event-stream" } : {}),
	};
}

function commonParams(edition, mode, sessionId, endpoints) {
	const env = endpoints ?? remoteEndpointsFor(edition);
	return JSON.stringify({
		language: env.language,
		app_language: edition === "intl" ? "en-US" : "zh-CN",
		quality: "stable",
		app_version: "1.0.0.1229",
		web_id: "",
		user_identity: "Free",
		is_freshman: "0",
		biz_user_id: "",
		user_unique_id: "",
		scope: env.scope,
		tenant: env.tenant,
		region: env.region,
		aiRegion: env.region,
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

function modelSessionId(edition, model) {
	return `dsh-trae-${edition === "intl" ? "intl-" : ""}${model}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Remote model configs for manual selection, cached per edition. The upstream
// silently falls back to its default model when a manual session omits the
// complete model object, so a specific model id must resolve to its
// custom_model before createSession.
const modelConfigCacheByEdition = { cn: undefined, intl: undefined };
const modelConfigFetchedAtByEdition = { cn: 0, intl: 0 };
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

async function fetchModelConfig(token, edition, modelName, signal, overrides) {
	const now = Date.now();
	if (modelConfigCacheByEdition[edition] === undefined || now - modelConfigFetchedAtByEdition[edition] > MODEL_CONFIG_TTL_MS) {
		const endpoints = remoteEndpointsFor(edition, overrides);
		if (endpoints.remoteBase === "") throw new Error(`trae model list: 未配置 ${edition === "intl" ? "国际版" : "国内版"} 上游地址`);
		const url = `${endpoints.remoteBase}/models?functions=solo_agent_remote&show_custom_model=true`;
		const response = await fetch(url, { headers: buildHeaders(token, edition, {}, endpoints), signal });
		if (!response.ok) throw new Error(`trae model list [${response.status}]`);
		const payload = await response.json();
		const configs = {};
		// Same dual-shape tolerance as parseModelList: data is either the model
		// array itself (CN) or a {list:[{function, models:[…]}]} wrapper (intl).
		const data = payload?.data;
		const groups = Array.isArray(data) ? [{ models: data }] : (data?.list ?? []);
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
		modelConfigCacheByEdition[edition] = configs;
		modelConfigFetchedAtByEdition[edition] = now;
	}
	const cache = modelConfigCacheByEdition[edition] ?? {};
	const exact = cache[modelName];
	if (exact !== undefined) return exact;
	const lowered = modelName.toLowerCase();
	for (const [name, config] of Object.entries(cache)) {
		if (name.toLowerCase() === lowered) return config;
	}
	return undefined;
}

/** Create one remote chat session; returns {sessionId, messageId}.
 * `options.useMaximumContextWindow` pins a max-mode-capable model to its 1M
 * profile (mirrors the desktop client's max session fields). */
export async function createSession(token, model, messages, signal, options = {}, edition = "cn") {
	const endpoints = remoteEndpointsFor(edition, options.endpoints);
	if (endpoints.remoteBase === "") {
		throw new Error(`trae ${edition === "intl" ? "国际版" : "国内版"} 上游地址未配置`);
	}
	const mode = "code";
	const modelName = model === "auto" ? "" : model;
	const sessionId = modelSessionId(edition, model);
	const initialMessage = {
		chat_session_id: "",
		content: [],
		query: flattenQuery(messages),
		model_name: modelName,
		agent_type: "solo_agent_remote",
		agent_id: "solo_agent_remote",
		model_selection_strategy: model === "auto" ? "auto" : "manual",
		common_params: commonParams(edition, mode, sessionId, endpoints),
	};
	if (model !== "auto") {
		const customModel = await fetchModelConfig(token, edition, model, signal, options.endpoints);
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
	const response = await fetch(`${endpoints.remoteBase}/chat_sessions`, {
		method: "POST",
		headers: buildHeaders(token, edition, {}, endpoints),
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
export async function* streamChat(token, model, messages, signal, options = {}, edition = "cn") {
	const { sessionId, messageId } = await createSession(token, model, messages, signal, options, edition);
	// Broadcast the remote session id BEFORE the event fetch: even if the
	// stream fails immediately, the consumer already holds the sessionId and
	// can clean the session up (即用即焚 delete).
	yield { type: "session", sessionId };
	const endpoints = remoteEndpointsFor(edition, options.endpoints);
	const url = `${endpoints.remoteBase}/chat_sessions/${sessionId}/events?reply_to_message_id=${encodeURIComponent(messageId)}`;
	const response = await fetch(url, { headers: buildHeaders(token, edition, { stream: true }, endpoints), signal });
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

/** Fetch the account's remaining credits (entitlement usage).
 * The credits endpoint is CN-verified (`https://api.trae.cn/…`). For the intl
 * edition the official credits host is UNKNOWN (unverified) and is NOT
 * guessed: callers must pass an explicit `creditsBase` (Config card), the
 * call throws otherwise. */
export async function fetchCredits(token, { edition = "cn", creditsBase } = {}) {
	const base = String(creditsBase ?? "").trim().replace(/\/+$/, "");
	if (base === "") {
		if (edition === "intl") throw new Error("国际版积分接口未配置（官方域名未经实测，请在设置卡填写后使用）");
		return fetchCredits(token, { edition, creditsBase: CREDITS_BASE });
	}
	const url = `${base}/trae/api/v2/pay/ide_user_ent_usage`;
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
export async function deleteSession(token, sessionId, edition = "cn", overrides) {
	if (typeof sessionId !== "string" || sessionId === "") return false;
	try {
		const endpoints = remoteEndpointsFor(edition, overrides);
		if (endpoints.remoteBase === "") return false;
		const response = await fetch(`${endpoints.remoteBase}/chat_sessions/${encodeURIComponent(sessionId)}`, {
			method: "DELETE",
			headers: buildHeaders(token, edition, {}, endpoints),
			signal: AbortSignal.timeout(15_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}
