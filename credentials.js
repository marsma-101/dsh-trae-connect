// credentials.js — Trae CN credential handling for dsh-trae-connect.
//
// The Trae CN desktop app (VS Code fork, "iCube") stores its sign-in inside
// `<APPDATA>/Trae CN/User/globalStorage/storage.json` under the
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
// Token renewal follows the same project's auth.py: POST
// `{host}/cloudide/api/v3/trae/oauth/ExchangeToken` with the refresh token
// and the fixed public ClientID.

import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Read + decrypt the Trae CN desktop app credential, or undefined. */
export function readDesktopAuth(explicitPath) {
	const candidates = explicitPath ? [explicitPath] : [
		join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Trae CN", "User", "globalStorage", "storage.json"),
	];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const storage = JSON.parse(readFileSync(path, "utf8"));
			const encrypted = storage?.[STORAGE_KEY];
			if (typeof encrypted !== "string" || encrypted.length === 0) continue;
			const trimmed = encrypted.trim();
			// International edition stores plain JSON under the same key.
			const plain = trimmed.startsWith("{")
				? trimmed
				: decryptStorageValue(trimmed);
			const auth = JSON.parse(plain);
			if (typeof auth?.token === "string" && auth.token.length > 0) {
				return { ...auth, _path: path };
			}
		} catch {
			continue;
		}
	}
	return undefined;
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
		this.path = options.path ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".trae-connect", "credentials.json");
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
		const desktop = readDesktopAuth();
		if (desktop !== undefined) {
			const { _path, ...auth } = desktop;
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
		if (this.current === undefined) throw new Error("trae-connect: Trae CN is not signed in on this machine");
		// Follow the desktop app on every resolve: re-login or token rotation
		// in the desktop app must be picked up within one turn, not after a
		// restart. A failed read keeps the current credential — an unreadable
		// file is not proof of sign-out.
		{
			const desktop = readDesktopAuth();
			if (desktop !== undefined) {
				const { _path, ...auth } = desktop;
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
		const host = typeof auth.host === "string" && auth.host.includes("api.trae") ? auth.host : CN_API_HOST;
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
				userId: auth.userId ?? "",
				host: auth.host ?? "",
				...(expiry === undefined ? {} : { expiresAt: expiry }),
				source: this.current?.source,
			};
		} catch (error) {
			return { state: "signed-out", reason: String(error?.message ?? error).slice(0, 300) };
		}
	}
}
