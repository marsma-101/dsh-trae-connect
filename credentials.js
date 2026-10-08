// credentials.js — Trae credential handling for dsh-trae-connect.
//
// The Trae desktop apps (VS Code forks, "iCube") store their sign-in inside
// `<APPDATA>/<data dir>/User/globalStorage/storage.json` under the
// `iCubeAuthInfo://icube.cloudide` key, encrypted with the "tc" envelope:
//
//   [6B header "tc\x05\x10\x00\x00"][32B random][AES-128-CBC ciphertext]
//   plaintext = [64B SHA-512 hash][PKCS7-padded JSON]
//   key/iv    = SHA-512(SHA-512(random) || SALT_A^SALT_B)[0..16]/[16..32]
//
// The salts are static constants baked into the app's frontend JS; the
// algorithm was documented by the MIT-licensed Trae2api-cn project
// (src/trae_decrypt.py) and is re-implemented here with node:crypto only.
//
// Edition discovery: the data directory name is NOT fixed. The domestic
// edition lives under `%APPDATA%\Trae CN` (tc-encrypted); the international
// edition uses `%APPDATA%\Trae` (tc-encrypted envelope under the same key —
// the CN decryption algorithm applies verbatim; live-verified 2026-10-08).
// TRAE SOLO adds `TRAE SOLO CN` / `TRAE SOLO`. discoverDesktopAuths() scans
// every `Trae*` directory under %APPDATA%, tries to read + decrypt each
// storage.json, and classifies the winner per edition. An explicit path
// (Config card or environment variable) always wins over the scan.
//
// Token renewal follows the same project's auth.py: POST
// `{host}/cloudide/api/v3/trae/oauth/ExchangeToken` with the refresh token
// and the fixed public ClientID.

import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const SALT_A = Buffer.from([
	82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
	124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
	84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
	8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const SALT_B = Buffer.from([
	31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
	96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
	160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
	23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);

const STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
/** Fixed public client id Trae's own clients present at token exchange. */
const CLIENT_ID = "ono9krqynydwx5";
/** API/OAuth host for CN personal accounts (auth.py forces this for cn). */
const CN_API_HOST = "https://api.trae.cn";

/** Reminder shown when the scan finds no usable credential at all. */
export const SIGN_IN_HINT =
	"请确认 Trae 桌面程序已启动并登录过（扫描模型列表与路径期间需保持程序处于启动状态）；首次使用请先在 Trae 里完成一次登录";

function xorInto(a, b) {
	const out = Buffer.alloc(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
	return out;
}

/** Decrypt one "tc" envelope into its plaintext JSON string. */
export function decryptStorageValue(base64Value) {
	const buffer = Buffer.from(base64Value, "base64");
	if (buffer.length < 38 + 64) throw new Error("trae-connect: tc envelope too short");
	const header = buffer.subarray(0, 6);
	const isTc = header[0] === 0x74 && header[1] === 0x63 &&
		header[2] === 0x05 && header[3] === 0x10 && header[4] === 0x00 && header[5] === 0x00;
	const isPrivate = header[0] === 18 && header[1] === 57 && header[2] === 32 &&
		header[3] === 32 && header[4] === 2 && header[5] === 3;
	if (!isTc && !isPrivate) {
		throw new Error(`trae-connect: unknown Trae encryption header ${header.toString("hex")}`);
	}
	const random = buffer.subarray(6, 38);
	const encrypted = buffer.subarray(38);
	const salt = isPrivate ? xorInto(SALT_A, SALT_B) : xorInto(SALT_A, SALT_B);
	const hashOfRandom = createHash("sha512").update(random).digest();
	const finalHash = createHash("sha512").update(Buffer.concat([hashOfRandom, salt])).digest();
	const key = finalHash.subarray(0, 16);
	const iv = finalHash.subarray(16, 32);
	const decipher = createDecipheriv("aes-128-cbc", key, iv);
	decipher.setAutoPadding(false);
	const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
	const storedHash = decrypted.subarray(0, 64);
	let body = decrypted.subarray(64);
	const pad = body[body.length - 1];
	if (pad >= 1 && pad <= 16 && body.length > pad) {
		let valid = true;
		for (let i = body.length - pad; i < body.length; i++) if (body[i] !== pad) { valid = false; break; }
		if (valid) body = body.subarray(0, body.length - pad);
	}
	const computed = createHash("sha512").update(body).digest();
	if (!storedHash.equals(computed)) throw new Error("trae-connect: Trae credential hash verification failed");
	return body.toString("utf8");
}

/**
 * Accept either a data directory (…/Trae CN) or a storage.json path and
 * return the storage.json path to read, or undefined for a blank value.
 */
function resolveStoragePath(rawPath) {
	const trimmed = String(rawPath ?? "").trim().replace(/^"|"$/g, "");
	if (trimmed === "") return undefined;
	if (/storage\.json$/i.test(trimmed)) return trimmed;
	return join(trimmed, "User", "globalStorage", "storage.json");
}

/** Read + decrypt one storage.json; undefined when it yields no valid token. */
function readStorageAuth(storagePath) {
	if (!existsSync(storagePath)) return undefined;
	try {
		const storage = JSON.parse(readFileSync(storagePath, "utf8"));
		const encrypted = storage?.[STORAGE_KEY];
		if (typeof encrypted !== "string" || encrypted.length === 0) return undefined;
		const trimmed = encrypted.trim();
		// Both editions use the tc envelope; plain JSON is kept as a
		// community-compat fallback.
		const plain = trimmed.startsWith("{")
			? trimmed
			: decryptStorageValue(trimmed);
		const auth = JSON.parse(plain);
		if (typeof auth?.token === "string" && auth.token.length > 0) return auth;
	} catch {
		// Not a Trae storage.json (or a foreign app sharing the prefix) — skip.
	}
	return undefined;
}

/**
 * Classify one decrypted desktop auth record as "cn" or "intl". The auth
 * record itself is authoritative (its host / region fields point at the
 * upstream the app was signed into); the directory name is only the last
 * resort. Directory-name heuristics: "…CN…" suffixed dirs are domestic
 * ("Trae CN", "TRAE SOLO CN"), everything else ("Trae", "TRAE SOLO",
 * "Trae - Insiders", …) leans international.
 */
export function classifyEdition(dirName, auth) {
	const host = String(auth?.host ?? "");
	if (/trae\.ai|byteintl|growsg|coresg|coreva/i.test(host)) return "intl";
	if (/trae\.cn|mchost\.guru/i.test(host)) return "cn";
	const region = String(auth?.userRegion?.region ?? auth?.region ?? "").toUpperCase();
	if (region === "CN") return "cn";
	if (["SG", "US", "JP", "HK", "VA", "GLOBAL", "INTL"].includes(region)) return "intl";
	return /\bcn\b/i.test(dirName) ? "cn" : "intl";
}

/**
 * Scan %APPDATA% for Trae desktop data directories and read every
 * storage.json that decrypts to a valid token. Explicit paths (Config card /
 * environment) are considered first and win over the scan per edition.
 * Returns { results, attempts, appData } where results.cn / results.intl
 * hold the first successful auth per edition ({...auth, _path, _edition})
 * and attempts is the per-candidate report used for startup logging.
 */
export function discoverDesktopAuths(options = {}) {
	const { logger, explicitCnPath, explicitIntlPath, quiet } = options;
	const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
	const results = { cn: undefined, intl: undefined };
	const attempts = [];
	const seen = new Set();

	const consider = (rawPath, forcedEdition, origin) => {
		const storage = resolveStoragePath(rawPath);
		if (storage === undefined) return;
		const key = storage.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		// storage.json sits at <dataDir>/User/globalStorage/storage.json.
		attempts.push({
			storage,
			dir: basename(dirname(dirname(dirname(storage)))),
			edition: forcedEdition,
			origin,
			ok: false,
			resolved: undefined,
		});
	};

	if (typeof explicitCnPath === "string" && explicitCnPath.trim() !== "") consider(explicitCnPath, "cn", "explicit");
	if (typeof explicitIntlPath === "string" && explicitIntlPath.trim() !== "") consider(explicitIntlPath, "intl", "explicit");

	let entries = [];
	try {
		entries = readdirSync(appData, { withFileTypes: true });
	} catch (error) {
		if (!quiet) logger?.warn?.(`dsh-trae-connect: cannot list ${appData} while scanning for Trae data directories`, error);
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^trae/i.test(entry.name)) continue;
		consider(join(appData, entry.name), undefined, "scan");
	}

	for (const attempt of attempts) {
		const auth = readStorageAuth(attempt.storage);
		if (auth === undefined) continue;
		attempt.ok = true;
		const edition = attempt.edition ?? classifyEdition(attempt.dir, auth);
		attempt.resolved = edition;
		if (results[edition] === undefined) {
			results[edition] = { ...auth, _path: attempt.storage, _edition: edition };
		}
	}

	if (!quiet) {
		if (attempts.length === 0) {
			logger?.info?.(`dsh-trae-connect: Trae 目录扫描 — ${appData} 下未发现 Trae* 数据目录`);
		} else {
			const detail = attempts
				.map((a) => a.ok ? `${a.dir} → ${a.resolved} 凭据可用（${a.storage}）` : `${a.dir} → 无可用凭据`)
				.join("；");
			logger?.info?.(`dsh-trae-connect: Trae 目录扫描（${attempts.length} 个候选）— ${detail}`);
		}
	}

	return { results, attempts, appData };
}

/**
 * Back-compat wrapper: the first usable domestic-edition desktop credential
 * (explicit path overrides the scan). Returns {...auth, _path} or undefined.
 */
export function readDesktopAuth(explicitPath) {
	return discoverDesktopAuths({ quiet: true, explicitCnPath: explicitPath }).results.cn;
}

/** Milliseconds until expiry; undefined when the record carries none. */
function expiresAtMs(auth) {
	const raw = String(auth?.expiredAt ?? "").trim();
	if (raw.length === 0) return undefined;
	const numeric = Number(raw);
	if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export class TraeCredentialStore {
	constructor(options = {}) {
		this.edition = options.edition ?? "cn";
		this.label = options.label ?? (this.edition === "cn" ? "Trae 国内版" : "Trae 国际版");
		const defaultCopy = this.edition === "cn" ? "credentials.json" : "credentials-intl.json";
		this.path = options.path ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".trae-connect", defaultCopy);
		/** Optional override for the international ExchangeToken host. */
		this.refreshHost = typeof options.refreshHost === "string" && options.refreshHost.trim() !== ""
			? options.refreshHost.trim().replace(/\/+$/, "")
			: undefined;
		/** Desktop discovery callback: () => {...auth, _path}|undefined. */
		this.discover = options.discover ?? (this.edition === "cn"
			? () => readDesktopAuth()
			: () => undefined);
		this.logger = options.logger;
		/** @type {{auth: object, source: string}|undefined} */
		this.current = undefined;
		this.inflightRefresh = undefined;
	}

	/** Load whatever credential exists: plugin copy first, desktop fallback. */
	load() {
		if (existsSync(this.path)) {
			try {
				const saved = JSON.parse(readFileSync(this.path, "utf8"));
				if (typeof saved?.auth?.token === "string" && saved.auth.token.length > 0) {
					this.current = { auth: saved.auth, source: "plugin-copy" };
					return this.current;
				}
			} catch {
				// fall through to desktop discovery
			}
		}
		const desktop = this.discover();
		if (desktop !== undefined) {
			const { _path, _edition, ...auth } = desktop;
			this.current = { auth, source: "desktop" };
			this.persist();
		}
		return this.current;
	}

	persist() {
		if (this.current === undefined) return;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.tmp`;
			writeFileSync(temporary, `${JSON.stringify({ version: 1, auth: this.current.auth }, null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
		} catch (error) {
			this.logger?.warn?.("dsh-trae-connect: could not persist the plugin credential copy", error);
		}
	}

	/** The live credential, resolving the desktop app when nothing is held. */
	async resolve() {
		if (this.current === undefined) this.load();
		if (this.current === undefined) {
			throw new Error(`trae-connect: 未找到可用的 ${this.label} 登录凭据 — ${SIGN_IN_HINT}`);
		}
		// Follow the desktop app on every resolve: re-login or token rotation
		// in the desktop app must be picked up within one turn, not after a
		// restart. A failed read keeps the current credential — an unreadable
		// file is not proof of sign-out.
		{
			const desktop = this.discover();
			if (desktop !== undefined) {
				const { _path, _edition, ...auth } = desktop;
				if (auth.token !== this.current.auth.token) {
					this.current = { auth, source: "desktop" };
					this.persist();
				}
			}
		}
		await this.maybeRefresh();
		return this.current.auth;
	}

	async maybeRefresh() {
		const auth = this.current?.auth;
		if (auth === undefined) return;
		const expiry = expiresAtMs(auth);
		if (expiry === undefined || expiry - Date.now() > 30 * 60 * 1000) return;
		if (this.inflightRefresh !== undefined) return this.inflightRefresh;
		this.inflightRefresh = this.refresh(auth).finally(() => {
			this.inflightRefresh = undefined;
		});
		return this.inflightRefresh;
	}

	async refresh(auth) {
		const refreshToken = auth.refreshToken;
		if (typeof refreshToken !== "string" || refreshToken.length === 0) {
			this.logger?.warn?.("dsh-trae-connect: token near expiry but no refresh token; keeping the current token");
			return;
		}
		let host;
		if (this.edition === "cn") {
			host = typeof auth.host === "string" && auth.host.includes("api.trae") ? auth.host : CN_API_HOST;
		} else {
			// International: the desktop record's own host IS the auth domain
			// (live-verified 2026-10-08: intl credentials carry
			// growsg-normal.trae.ai — the ExchangeToken host, NOT the remote
			// gate; the official trae2api PROTOCOL.md records the same). It
			// therefore wins over the remoteBase-derived refreshHost override.
			host = (typeof auth.host === "string" && /trae\.(ai|cn)/i.test(auth.host)
				? auth.host
				: undefined) ?? this.refreshHost;
			if (host === undefined) {
				this.logger?.warn?.("dsh-trae-connect: 国际版令牌临近过期，但凭据记录未携带鉴权域名；跳过自动续期，沿用当前令牌");
				return;
			}
		}
		const url = `${host.replace(/\/+$/, "")}/cloudide/api/v3/trae/oauth/ExchangeToken`;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					ClientID: CLIENT_ID,
					RefreshToken: refreshToken,
					ClientSecret: "-",
					UserID: auth.userId ?? "",
				}),
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) throw new Error(`http ${response.status}`);
			const payload = await response.json();
			const result = payload?.Result ?? payload?.result ?? {};
			const token = result.Token ?? result.token ?? "";
			if (token.length === 0) throw new Error("exchange returned no token");
			const next = {
				...auth,
				token,
				refreshToken: result.RefreshToken ?? result.refreshToken ?? refreshToken,
			};
			const expireRaw = result.TokenExpireAt ?? result.tokenExpireAt ?? "";
			if (expireRaw !== "") next.expiredAt = String(expireRaw);
			this.current = { auth: next, source: this.current.source };
			this.persist();
			this.logger?.info?.("dsh-trae-connect: Trae token refreshed");
		} catch (error) {
			this.logger?.warn?.("dsh-trae-connect: Trae token refresh failed; keeping the current token", error);
		}
	}

	/** Card status summary; never throws. */
	async status() {
		try {
			const auth = await this.resolve();
			const expiry = expiresAtMs(auth);
			return {
				state: "signed-in",
				edition: this.edition,
				userId: auth.userId ?? "",
				host: auth.host ?? "",
				...(expiry === undefined ? {} : { expiresAt: expiry }),
				source: this.current?.source,
			};
		} catch (error) {
			return { state: "signed-out", edition: this.edition, reason: String(error?.message ?? error).slice(0, 300) };
		}
	}

	/**
	 * Drop the held credential (desktop sign-out sweep): forget the in-memory
	 * copy and delete the plugin copy so the next resolve() re-reads the
	 * desktop state instead of resurrecting a stale token.
	 */
	forget() {
		this.current = undefined;
		this.inflightRefresh = undefined;
		try {
			if (existsSync(this.path)) unlinkSync(this.path);
		} catch (error) {
			this.logger?.warn?.("dsh-trae-connect: could not remove the plugin credential copy", error);
		}
	}
}
