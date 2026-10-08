// index.js — dsh-trae-connect plugin entry.
//
// Structure mirrors dsh-workbuddy-connect: a loopback HTTP shim that speaks
// the OpenAI completions shape, a PiAiAdapter whose models point at that
// shim, and a status route for the settings card. The difference lives
// behind the shim: instead of Tencent's WorkBuddy endpoints we translate to
// Trae's remote-session protocol using the desktop app's decrypted
// sign-in (credentials.js + upstream.js).
//
// Editions: the domestic (CN) and international (intl) desktop editions are
// discovered independently (directory scan over %APPDATA%\Trae*, explicit
// overrides win) and registered UNCONDITIONALLY as two providers — `trae`
// (Trae 国内版) and `trae-intl` (Trae 国际版). Mirroring dsh-workbuddy-connect
// (lib/index.js L2073-2076): the provider always registers and what varies is
// whether its catalog is visible — an edition without a credential publishes
// an EMPTY catalog (the host filters out groups with no models), and a
// sign-in that happens after startup is picked up by a lightweight credential
// sweep, which fills the catalog and republishes. No re-registration.

import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import {
	TraeCredentialStore,
	discoverDesktopAuths,
	SIGN_IN_HINT,
} from "./credentials.js";
import {
	currentModels,
	resetLiveModels,
	INTL_PLACEHOLDER_MODELS,
	isMaxModeModel,
	refreshModelsIfStale,
	streamChat,
	fetchCredits,
	deleteSession,
	remoteEndpointsFor,
	// detectInstall (re-exported by upstream.js so the import graph above stays
	// one line) locates the installed Trae program; applyDetectedInstall hands
	// its answer to the remote-gate resolution — both added 2026-10-08.
	detectInstall,
	applyDetectedInstall,
} from "./upstream.js";

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
	dataDirCn: z.string()
		.default("")
		.volatile()
		.description("国内版数据目录或 storage.json 显式路径（留空自动扫描 %APPDATA%\\Trae*；填写后优先生效）"),
	dataDirIntl: z.string()
		.default("")
		.volatile()
		.description("国际版数据目录或 storage.json 显式路径（留空自动扫描 %APPDATA%\\Trae*；填写后优先生效）"),
	intlRemoteBase: z.string()
		.default("")
		.volatile()
		.description("国际版上游地址（remote v1 根）。留空即自动取已安装 Trae 程序 product.json 里按账号地区选出的镜像（2026-10-08 起；如 SG 账号 coresg-normal.trae.ai），未检测到安装时回落到内置默认 https://core-normal.trae.ai/api/remote/v1。填写后强制覆盖自动检测。"),
	intlWebOrigin: z.string()
		.default("")
		.volatile()
		.description("国际版 Web Origin。留空即取已安装程序的 product.json soloUrl（实测 https://work.trae.ai），填写后强制覆盖自动检测。"),
	intlCreditsBase: z.string()
		.default("")
		.volatile()
		.description("国际版积分接口根地址（官方域名未经实测；留空则国际版状态卡不查积分）"),
});

/** Read one config field tolerating both accessor and plain-value shapes. */
function readConfigValue(value) {
	if (value === null || value === undefined) return undefined;
	return typeof value.get === "function" ? value.get() : value;
}

const TRAE_PROVIDER = "trae";
const TRAE_INTL_PROVIDER = "trae-intl";
/** Per-edition provider/group/display names. */
const EDITION_META = {
	cn: {
		edition: "cn",
		providerId: TRAE_PROVIDER,
		groupName: "Trae",
		displayName: "Trae 国内版",
	},
	intl: {
		edition: "intl",
		providerId: TRAE_INTL_PROVIDER,
		groupName: "Trae Intl",
		displayName: "Trae 国际版",
	},
};
const EDITIONS = ["cn", "intl"];
const TRAE_STREAM_IDLE_TIMEOUT_MS = 300_000;
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const SHARED_SECRET = "trae-connect-local";
// One bearer secret per edition: the shim identifies the caller's edition
// from the Authorization header (model ids can collide between the two
// catalogs, so the model name must not decide routing).
const EDITION_SECRETS = { cn: SHARED_SECRET, intl: `${SHARED_SECRET}-intl` };
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
 * per-process bearer secret and loopback Host/Origin checks. The caller's
 * edition is identified by its per-edition bearer token (EDITION_SECRETS).
 */
function createTraeShim({ stores, logger, preferences, endpointsFor }) {
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
		if (match === null) return undefined;
		return Object.entries(EDITION_SECRETS).find(([, secret]) => match[1] === secret)?.[0];
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
			const bearerEdition = bearerOk(req);
			if (bearerEdition === undefined) {
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
					data: currentModels(bearerEdition).map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: bearerEdition,
					})),
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res, bearerEdition);
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

	async function chatCompletions(req, res, edition) {
		const contentType = String(req.headers["content-type"] ?? "");
		if (!contentType.includes("application/json")) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		let body;
		try {
			body = JSON.parse(await readBody(req));
		} catch (error) {
			writeOpenAIError(res, 400, "invalid_request", `invalid JSON body: ${safeMessage(error)}`);
			return;
		}
		const requestedModel = String(body.model ?? "auto");
		// The pi-ai provider ids carry the edition prefix in the wire model
		// (`trae@model` / `trae-intl@model`); strip it for the upstream call.
		const prefixed = /^trae(?:-intl)?@(.+)$/.exec(requestedModel);
		const model = prefixed === null ? requestedModel : prefixed[1];
		const store = stores[edition];
		// Both editions always have a store now (unconditional registration);
		// the 404 fires when the edition holds no usable credential at all.
		if (store === undefined || store.current === undefined) {
			writeOpenAIError(res, 404, "edition_not_available", `trae ${edition} 分组未启用（本机未发现该版本的登录凭据）`);
			return;
		}
		let auth;
		try {
			auth = await store.resolve();
		} catch (error) {
			writeOpenAIError(res, 401, "not_signed_in", safeMessage(error));
			return;
		}
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const stream = body.stream === true;
		const controller = new AbortController();
		req.on("close", () => controller.abort());

		const sessionOptions = {
			useMaximumContextWindow: preferences.useMaximumContextWindow() === true,
			...(typeof body.reasoning_effort === "string" && body.reasoning_effort !== "" ? { reasoningEffort: body.reasoning_effort } : {}),
			endpoints: endpointsFor(edition),
		};

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
				let textTotal = 0;
				let failed;
				let sessionId;
				try {
					for await (const piece of streamChat(auth.token, model, messages, controller.signal, sessionOptions, edition)) {
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
					void deleteSession(auth.token, sessionId, edition, sessionOptions.endpoints).catch(() => {});
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
				for await (const piece of streamChat(auth.token, model, messages, controller.signal, sessionOptions, edition)) {
					if (piece.type === "text") content += piece.text;
					else if (piece.type === "reasoning") reasoning += piece.text;
					else if (piece.type === "usage") usage = piece;
					else if (piece.type === "session") sessionId = piece.sessionId;
				}
				// 即用即焚 cleanup, same fire-and-forget as the streaming branch.
				if (preferences.autoDeleteSession() === true && sessionId !== undefined) {
					void deleteSession(auth.token, sessionId, edition, sessionOptions.endpoints).catch(() => {});
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
				// The intl roster intentionally includes locked models (the full
				// tier view); when the upstream rejects one, say why instead of
				// passing the bare protocol error through.
				const detail = safeMessage(error);
				const hint = edition === "intl" && detail.includes("not available")
					? "（该模型需升级 Trae 付费档后使用）"
					: "";
				writeOpenAIError(res, 502, "upstream_error", `trae upstream: ${detail}${hint}`);
			} else {
				try { res.end(); } catch {}
			}
		}
	}

	return {
		ready,
		baseUrl: () => (address === undefined ? "" : `http://127.0.0.1:${address.port}`),
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

function toPiModel(info, baseUrl, useMaximumContextWindow, providerId = TRAE_PROVIDER) {
	const useMax = useMaximumContextWindow === true && isMaxModeModel(info);
	const efforts = Array.isArray(info.traeEfforts) ? info.traeEfforts : [];
	// Price display mirrors dsh-qoder-connect / dsh-workbuddy-connect: a zero
	// rate means free, other rates show as a multiplier. Models without a
	// declared consumption_rate (experimental slots) get no suffix. Locked
	// models (intl tier view) carry their `· 🔒 未解锁` badge inside info.name
	// from upstream.js — computed per catalog refresh from the live features
	// data — and upstream.js drops their rate, so no multiplier shows here.
	const priceSuffix = info.traeRate === undefined || info.traeRate === null
		? ""
		: info.traeRate === 0 ? " · 免费" : ` · x${info.traeRate}`;
	return {
		id: info.id,
		name: `${info.name}${priceSuffix}`,
		api: "openai-completions",
		provider: providerId,
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

// Placeholder roster lives in upstream.js (INTL_PLACEHOLDER_MODELS) — the
// exact same list currentModels() serves for an edition that never fetched a
// catalog, so the card state and the /v1/models answer cannot drift apart.
const UNCONFIGURED_INTL_MODELS = INTL_PLACEHOLDER_MODELS;

function createTraeAdapter({ shim, store, meta, logger, preferences, endpointsFor }) {
	const buildModels = () => {
		// The WorkBuddy hide mechanism: an edition without a usable credential
		// publishes an empty catalog — the host filters out groups with no
		// models, so the group vanishes from the picker without ever
		// unregistering the provider. The credential check is cheap (store
		// state, no disk I/O beyond the shim URL).
		if (store.current === undefined) return [];
		const baseUrl = `${shim.baseUrl()}/v1`;
		const useMaximumContextWindow = preferences.useMaximumContextWindow() === true;
		// An intl group without a verified/configured upstream keeps a single
		// placeholder instead of the CN fallback roster — showing CN model
		// names under the intl group would be misleading.
		const roster = meta.edition === "intl" && endpointsFor(meta.edition).remoteBase === ""
			? UNCONFIGURED_INTL_MODELS
			: currentModels(meta.edition);
		return roster.map((info) => toPiModel(info, baseUrl, useMaximumContextWindow, meta.providerId));
	};
	const provider = {
		...createProvider({
			id: meta.providerId,
			name: meta.groupName,
			auth: { apiKey: {
				name: "Trae Cloud-IDE-JWT bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === undefined || apiKey.length === 0 ? undefined : {
						auth: { apiKey },
						source: meta.groupName,
					};
				},
			} },
			models: buildModels(),
			api: openAICompletionsApi(),
		}),
		getModels: () => buildModels(),
	};
	const profile = {
		provider: meta.providerId,
		displayName: meta.displayName,
		streamIdleTimeoutMs: TRAE_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(undefined, "dsh-trae-connect retryPolicy"),
		configuredMaxTokens: new Map(),
		modelErrors: new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider,
	};
	const profiles = new Map([[meta.providerId, profile]]);
	const adapter = new PiAiAdapter({
		profiles: () => profiles,
		auth: INERT_AUTH,
		resolveApiKey: async () => EDITION_SECRETS[meta.edition] ?? SHARED_SECRET,
	});
	return {
		adapter,
		// A catalog refresh rebuilds the snapshot so listModels/resolveModel
		// pick up the new roster, exactly like a WorkBuddy catalog update.
		invalidate: () => {
			profiles.set(meta.providerId, { ...profile });
		},
	};
}

function createEditionStatus({ edition, store, endpointsFor, preferences }) {
	return async function traeWebStatus() {
		const authStatus = await store.status();
		if (authStatus.state !== "signed-in") return { status: "signed-out", ...authStatus };
		const status = { status: "signed-in", ...authStatus };
		if (edition === "intl") {
			const configured = endpointsFor(edition).remoteBase !== "";
			if (!configured) return { ...status, upstreamConfigured: false };
		}
		try {
			const auth = await store.resolve();
			const credits = await fetchCredits(auth.token, { edition, creditsBase: preferences.intlCreditsBase() });
			return { ...status, credits, upstreamConfigured: true };
		} catch (error) {
			return { ...status, creditsError: safeMessage(error) };
		}
	};
}

export async function apply(ctx, config) {
	const logger = ctx.logger;
	/** Live preference read; tolerates accessor and plain-value shapes. */
	const preferences = {
		useMaximumContextWindow: () => readConfigValue(config?.useMaximumContextWindow) === true,
		autoDeleteSession: () => readConfigValue(config?.autoDeleteSession) !== false,
		dataDirCn: () => String(readConfigValue(config?.dataDirCn) ?? "").trim(),
		dataDirIntl: () => String(readConfigValue(config?.dataDirIntl) ?? "").trim(),
		intlRemoteBase: () => String(readConfigValue(config?.intlRemoteBase) ?? "").trim() || (process.env.TRAE_INTL_REMOTE_BASE ?? "").trim(),
		intlWebOrigin: () => String(readConfigValue(config?.intlWebOrigin) ?? "").trim() || (process.env.TRAE_INTL_WEB_ORIGIN ?? "").trim(),
		intlCreditsBase: () => String(readConfigValue(config?.intlCreditsBase) ?? "").trim(),
	};

	// Effective endpoints per edition, re-read on every use so a Config-card
	// edit takes effect without a restart.
	const endpointsFor = (edition) => remoteEndpointsFor(edition, {
		remoteBase: edition === "intl" ? preferences.intlRemoteBase() : "",
		webOrigin: edition === "intl" ? preferences.intlWebOrigin() : "",
	});

	// --- Edition discovery -------------------------------------------------
	// One startup scan logs the candidates; each edition's store re-scans on
	// resolve() (desktop re-login must be picked up within one turn), so the
	// scan itself stays cheap and quiet after startup.
	//
	// discoverDesktopAuths is async (it consults the installed app for the
	// edition verdict), so it MUST be awaited here — before this it was called
	// without await, and `startupScan.results` was read off a Promise, so the
	// startup log and the region→remote-gate detection below saw nothing.
	const startupScan = await discoverDesktopAuths({
		logger,
		explicitCnPath: preferences.dataDirCn() || process.env.TRAE_DATA_DIR_CN,
		explicitIntlPath: preferences.dataDirIntl() || process.env.TRAE_DATA_DIR_INTL,
	});
	const found = startupScan.results;

	// Resolved credential records per edition, refreshed by the same awaited
	// discovery that feeds each store's `discover` callback (2026-10-08).
	// TraeCredentialStore calls that callback SYNCHRONOUSLY from load()/resolve()
	// (credentials.js is intentionally not changed), so the awaited result is
	// published here and the callback reads this cache instead of returning a
	// Promise — otherwise `load()` would destructure a Promise into an empty
	// credential and persist it.
	const desktopAuthByEdition = { cn: undefined, intl: undefined };
	/** Run one discovery pass and publish every edition's record. */
	const refreshDesktopAuths = async (options = {}) => {
		const scan = await discoverDesktopAuths({
			logger,
			explicitCnPath: preferences.dataDirCn() || process.env.TRAE_DATA_DIR_CN,
			explicitIntlPath: preferences.dataDirIntl() || process.env.TRAE_DATA_DIR_INTL,
			quiet: true,
			...options,
		});
		desktopAuthByEdition.cn = scan.results.cn;
		desktopAuthByEdition.intl = scan.results.intl;
		return scan.results;
	};
	desktopAuthByEdition.cn = found.cn;
	desktopAuthByEdition.intl = found.intl;
	/** In-flight discovery pass, shared so concurrent callers scan once. */
	let desktopAuthScan;
	/**
	 * Awaitable refresh used by the async paths (startup sweep, credential
	 * sweep). Coalesces concurrent callers onto one discovery pass; the sync
	 * `discover` callback below awaits it too, but never blocks on it.
	 */
	const ensureDesktopAuthScan = async () => {
		desktopAuthScan ??= refreshDesktopAuths().finally(() => {
			desktopAuthScan = undefined;
		});
		return desktopAuthScan;
	};

	if (found.cn === undefined && found.intl === undefined) {
		logger.warn?.(`dsh-trae-connect: 未找到任何可解密的 Trae 登录凭据（候选目录见上方扫描日志）。${SIGN_IN_HINT}`);
	}
	for (const edition of EDITIONS) {
		if (found[edition] !== undefined) {
			logger.info?.(`dsh-trae-connect: ${EDITION_META[edition].displayName} 凭据来自 ${found[edition]._path}`);
		} else {
			logger.info?.(`dsh-trae-connect: ${EDITION_META[edition].displayName} 未在本机发现已登录凭据`);
		}
	}

	// The remote gate is region-dependent (product.json picks a mirror per
	// account region), so detection runs per edition with THAT edition's region
	// taken from its own credential record. detection only prefers the installed
	// app's hosts; remoteEndpointsFor still lets a Config-card/env override win
	// over it, and a detection failure must never stop the plugin from
	// starting — either way the compiled-in table applies.
	for (const edition of EDITIONS) {
		try {
			const region = String(found[edition]?.userRegion?.region ?? "").trim();
			const install = await detectInstall(edition, region);
			applyDetectedInstall(edition, install);
			if (install.source !== "compiled-in") {
				logger.info?.(`dsh-trae-connect: ${EDITION_META[edition].displayName} 上游来自已安装程序（${install.appRoot}${region === "" ? "" : `，账号地区 ${region}`}）— ${install.remoteBase}`);
			}
		} catch (error) {
			applyDetectedInstall(edition, undefined);
			logger.warn?.(`dsh-trae-connect: ${EDITION_META[edition].displayName} 安装检测失败（${safeMessage(error)}），沿用内置上游地址`);
		}
	}

	const stores = {};
	const adapters = {};
	// Unconditional registration (WorkBuddy-style): both editions always
	// register their provider; what varies is whether the catalog is visible
	// (empty catalog = the host hides the group).
	const registered = [];

	const shim = createTraeShim({
		stores,
		logger,
		preferences,
		endpointsFor,
	});
	try {
		await shim.ready;
	} catch (error) {
		logger.error("dsh-trae-connect: Trae loopback endpoint failed to start", error);
		return;
	}

	try {
		const releaseAdapters = [];
		/** What the last credential sweep saw per edition: { userId|undefined }. */
		const sweepState = new Map();
		/** Consecutive "credential gone" sightings per edition (sign-out needs 2). */
		const sweepMisses = new Map();
		for (const edition of EDITIONS) {
			const meta = EDITION_META[edition];
			const store = new TraeCredentialStore({
				edition,
				logger,
				// intl refreshHost override: only a fallback — the credential
				// record's own host (the auth domain, live-verified) wins.
				...(edition === "cn" ? {} : { refreshHost: preferences.intlRemoteBase() }),
				// Synchronous reader of the discovery result that
				// refreshDesktopAuths() already awaited (2026-10-08).
				//
				// Why not `discover: async () => (await discoverDesktopAuths(...)).results[edition]`:
				// TraeCredentialStore consumes this callback synchronously
				// (credentials.js load() line ~572 and resolve() line ~604), so an
				// async callback hands it a Promise; `const {_path, _edition,
				// ...auth} = promise` yields an EMPTY auth, which load() then
				// persists over the real credential, and resolve() treats as a
				// token change. Since credentials.js is out of scope for this
				// change, the await lives here instead: each call kicks one
				// shared discovery pass (same cost the old sync call had) and
				// answers from the last resolved record, so a desktop re-login
				// is still picked up on the next resolve().
				discover: () => {
					void ensureDesktopAuthScan();
					return desktopAuthByEdition[edition];
				},
			});
			store.load();
			stores[edition] = store;
			const trae = createTraeAdapter({
				shim,
				store,
				meta,
				logger,
				preferences,
				endpointsFor,
			});
			adapters[edition] = trae;
			const releaseAdapter = ctx.llm.registerAdapter([meta.providerId], trae.adapter);
			releaseAdapters.push(releaseAdapter);
			registered.push(edition);
			const userId = store.current?.auth?.userId;
			sweepState.set(edition, { userId: userId === undefined ? undefined : String(userId) });
			logger.info?.(store.current === undefined
				? `dsh-trae-connect: ${meta.displayName} 分组已注册，暂无凭据（目录为空，登录后自动出现）`
				: `dsh-trae-connect: ${meta.displayName} 分组已挂载（provider ${meta.providerId}）`);
		}
		try {
			ctx.effect(() => () => {
				for (const release of releaseAdapters) release();
				shim.close();
			});
		} catch {
			// Older hosts without effect(): the outer catch below still closes
			// the shim if registration throws before this point is reached.
		}
		// A live settings edit republishes the descriptors so the context-window
		// preference takes effect on the next request without a restart.
		try {
			ctx.on("loader/volatile-update", () => {
				for (const edition of registered) adapters[edition]?.invalidate();
				ctx.emit?.("llm/adapters-updated");
			});
		} catch {
			// Hosts without the event keep restart-required semantics for edits.
		}
		// Settings-card status routes (loopback-only, same guard as the shim).
		for (const edition of registered) {
			const meta = EDITION_META[edition];
			try {
				ctx.effect(() => {
					const dispose = ctx.webServer.register({
						kind: "exact",
						path: `/plugins/dsh-trae-connect/status${edition === "intl" ? "-intl" : ""}`,
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
								writeJson(res, 200, await createEditionStatus({
									edition,
									store: stores[edition],
									endpointsFor,
									preferences,
								})());
							} catch (error) {
								writeJson(res, 500, { error: safeMessage(error) });
							}
						},
					});
					return () => dispose();
				}, `dsh-trae-connect: Web status route (${meta.displayName})`);
			} catch {
				// Older hosts without webServer registration keep working without the card.
			}
		}
		// Startup: resolve the credential, pull the LIVE model roster per
		// edition, then publish it into the adapter so the picker shows every
		// model the account actually has (not the fallback subset). Repeated
		// on a timer. The intl edition only syncs when its upstream is set.
		const syncCatalog = async (edition) => {
			const trae = adapters[edition];
			const store = stores[edition];
			if (trae === undefined || store === undefined || store.current === undefined) return;
			try {
				const auth = await store.resolve();
				if (edition === "intl" && endpointsFor(edition).remoteBase === "") {
					logger.warn?.(`dsh-trae-connect: ${EDITION_META[edition].displayName} 上游地址被清空 — 分组保留凭据状态，模型目录仅出占位项`);
					trae.invalidate();
					return;
				}
				const previousIds = new Set(currentModels(edition).map((model) => model.id));
				const models = await refreshModelsIfStale(auth.token, logger, edition, endpointsFor(edition));
				const changed = models.length !== previousIds.size || models.some((model) => !previousIds.has(model.id));
				logger.info?.(`dsh-trae-connect: ${EDITION_META[edition].displayName} catalog ${models.length} models (user ${auth.userId ?? "unknown"})${changed ? " — updated" : ""}`);
				if (changed) trae.invalidate();
			} catch (error) {
				logger.warn?.(`dsh-trae-connect: ${EDITION_META[edition].displayName} catalog sync failed (${safeMessage(error)}); serving the fallback roster`);
			}
		};
		for (const edition of registered) void syncCatalog(edition);
		const catalogTimer = setInterval(() => {
			for (const edition of registered) void syncCatalog(edition);
		}, 10 * 60 * 1000);
		catalogTimer.unref?.();
		try {
			ctx.effect(() => () => clearInterval(catalogTimer));
		} catch {
			clearInterval(catalogTimer);
		}
		// --- Credential sweep (WorkBuddy syncVariant, trimmed) ----------------
		// A light ~30s loop that watches each edition's credential presence and
		// identity so a desktop sign-in / sign-out / account switch is picked
		// up without a restart. Presence/identity come from store.discover()
		// (the desktop record — the source of truth for sign-in state; the
		// in-memory plugin copy must not mask a desktop sign-out). Only a
		// *change* triggers the heavy work: catalog fill/clear + invalidate +
		// republish; the no-change path is one cheap discovery read per
		// edition per sweep.
		const publishCatalogs = () => {
			ctx.emit?.("llm/adapters-updated");
		};
		const adoptCredential = async (edition, meta, identity) => {
			const store = stores[edition];
			const trae = adapters[edition];
			const previous = sweepState.get(edition);
			const hadCredential = previous?.userId !== undefined;
			if (identity === undefined) {
				if (!hadCredential) {
					sweepMisses.set(edition, 0);
					return;
				}
				// Require two consecutive "gone" sightings so a momentary
				// unreadable storage.json (desktop app mid-write, locked file)
				// is not misread as a sign-out.
				const misses = (sweepMisses.get(edition) ?? 0) + 1;
				sweepMisses.set(edition, misses);
				if (misses < 2) return;
				sweepMisses.set(edition, 0);
				sweepState.set(edition, { userId: undefined });
				// Sign-out: stop serving the account's models entirely and hide
				// the group (empty catalog). The live roster is wiped so a later
				// re-login cannot briefly serve the departing account's list.
				store.forget();
				resetLiveModels(edition);
				trae.invalidate();
				logger.info?.(`dsh-trae-connect: ${meta.displayName} 凭据已消失 — 分组目录清空（登录后自动恢复）`);
				publishCatalogs();
				return;
			}
			sweepMisses.set(edition, 0);
			if (hadCredential && previous.userId === identity.userId) return; // same identity: skip
			if (hadCredential) {
				// Identity switch: the old catalog is void; wipe what the sync
				// had fetched so the group does not leak the other account's
				// roster while the new one is being pulled.
				resetLiveModels(edition);
			}
			sweepState.set(edition, { userId: identity.userId });
			// Re-run the install detection on a new login or an account switch
			// (2026-10-08): the remote gate is chosen per account REGION, so an
			// account that moved region (or replaced the previous one) would keep
			// talking to the old mirror if the gate were only resolved at
			// startup. Done BEFORE syncCatalog() so the catalog pull already uses
			// the corrected remoteBase, and wrapped so a discovery failure falls
			// back to the compiled-in table instead of failing the sign-in path.
			try {
				const region = identity.region || String(store.current?.auth?.userRegion?.region ?? "").trim();
				const install = await detectInstall(edition, region);
				applyDetectedInstall(edition, install);
				logger.info?.(`dsh-trae-connect: ${meta.displayName} 上游重检（${install.source}${region === "" ? "" : `，账号地区 ${region}`}）— ${install.remoteBase}`);
			} catch (error) {
				applyDetectedInstall(edition, undefined);
				logger.warn?.(`dsh-trae-connect: ${meta.displayName} 上游重检失败（${safeMessage(error)}），沿用内置上游地址`);
			}
			logger.info?.(`dsh-trae-connect: ${meta.displayName} ${hadCredential ? "登录身份已切换" : "检测到新登录凭据"} — 填充模型目录`);
			trae.invalidate();
			publishCatalogs();
			await syncCatalog(edition);
			publishCatalogs();
		};
		const sweepCredentials = async (edition) => {
			const meta = EDITION_META[edition];
			const store = stores[edition];
			if (store === undefined) return;
			// The desktop record is the sign-in source of truth, and it is read
			// asynchronously (2026-10-08: discoverDesktopAuths is async because
			// the edition verdict consults the installed app). Await the scan
			// FIRST, then read the store — a sync read before the await would
			// only see the previous pass's record and could miss a re-login by a
			// whole sweep interval. A failed read is treated as "no sighting"
			// (the two-miss rule above decides whether that means signed out).
			await ensureDesktopAuthScan();
			const desktop = store.discover();
			const identity = desktop === undefined
				? undefined
				: {
					userId: desktop.userId === undefined ? "?" : String(desktop.userId),
					// Carried so a new login / account switch can re-run the
					// install detection with THIS account's region.
					region: String(desktop.userRegion?.region ?? "").trim(),
				};
			await adoptCredential(edition, meta, identity);
		};
		const sweepAll = async () => {
			for (const edition of registered) await sweepCredentials(edition);
		};
		void sweepAll();
		const sweepTimer = setInterval(() => {
			void sweepAll();
		}, 30 * 1000);
		sweepTimer.unref?.();
		try {
			ctx.effect(() => () => clearInterval(sweepTimer));
		} catch {
			clearInterval(sweepTimer);
		}
	} catch (error) {
		logger.error("dsh-trae-connect: Trae provider registration failed", error);
		shim.close();
	}
}

export const name = "dsh-trae-connect";
export const inject = ["llm"];
export { createTraeShim };
