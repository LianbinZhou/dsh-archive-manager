/**
 * Pure filesystem helpers behind the physical-delete path.
 *
 * Deliberately free of any DSH/cordis import so the delete route's safety
 * guarantees can be pinned by a plain Node test run: id normalisation, session
 * directory discovery, the sessions-root containment check, realpath-validated
 * removal, and the projection-cache scrub.
 *
 * @module dsh-archive-manager/host/paths
 */

import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Resolve the harness home directory: `$DSH_HOME` wins (relative values are
 * resolved against the process cwd, mirroring the official resolver), then
 * the platform home fallback `~/.dsh`.
 * @returns the absolute harness home path.
 */
function dshHome() {
	const raw = process.env.DSH_HOME;
	if (typeof raw === "string" && raw.trim() !== "") {
		const trimmed = raw.trim();
		return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
	}
	return join(homedir(), ".dsh");
}

/**
 * Canonical session id. DSH keys a session's storage segment off the id: a
 * `session-<uuid>` id may land as segment `<uuid>`, and the archive set mixes
 * both spellings, so every comparison goes through this normal form.
 * @param id - raw session id in either spelling.
 * @returns the `session-`-prefixed form.
 */
function canonicalSessionId(id) {
	return id.startsWith("session-") ? id : `session-${id}`;
}

/**
 * Reject anything that could escape the sessions root by construction. Ids
 * are only ever matched against real directory names, but a guard keeps a
 * malformed request from ever reaching the filesystem walk.
 * @param id - candidate session id from the request body.
 */
function isSafeSessionId(id) {
	return (
		typeof id === "string" &&
		id.length > 0 &&
		id.length <= 256 &&
		!id.includes("/") &&
		!id.includes("\\") &&
		!id.includes("..")
	);
}

/** True when `child` is `root` itself or lies underneath it (lexical). */
function isInside(root, child) {
	const rootAbs = resolve(root);
	const childAbs = resolve(child);
	if (childAbs === rootAbs) return true;
	return childAbs.startsWith(rootAbs + sep);
}

/**
 * Locate one session's storage directory: `<sessionsRoot>/<project>/<segment>`
 * where the project dir is the cwd-encoded key and the segment is the session
 * id (bare uuid or prefixed). A candidate whose realpath escapes the sessions
 * root is never returned, so symlinks cannot redirect a delete.
 * @param sessionsRoot - absolute `<dshHome>/sessions`.
 * @param sessionId - canonical or bare session id.
 * @returns the absolute session directory path, or undefined when absent.
 */
function findSessionDir(sessionsRoot, sessionId) {
	const wanted = new Set([sessionId, sessionId.replace(/^session-/, "")]);
	let rootReal;
	try {
		rootReal = realpathSync(sessionsRoot);
	} catch {
		return void 0;
	}
	let projects;
	try {
		projects = readdirSync(sessionsRoot);
	} catch {
		return void 0;
	}
	for (const project of projects) {
		const projectPath = join(sessionsRoot, project);
		let segments;
		try {
			segments = readdirSync(projectPath);
		} catch {
			continue;
		}
		for (const segment of segments) {
			if (!wanted.has(segment)) continue;
			const dirPath = join(projectPath, segment);
			try {
				if (!statSync(dirPath).isDirectory()) continue;
				if (!isInside(rootReal, realpathSync(dirPath))) continue;
			} catch {
				continue;
			}
			return dirPath;
		}
	}
	return void 0;
}

/**
 * Physically remove one session directory. The path is re-validated by
 * realpath against the sessions root immediately before the recursive
 * removal, so no caller-supplied path can reach anything outside session
 * storage. `force: false` keeps a surprise (a vanished tree) loud instead of
 * silently reporting success.
 * @param dirPath - directory resolved by {@link findSessionDir}.
 * @param sessionsRoot - absolute `<dshHome>/sessions`.
 */
function removeSessionDir(dirPath, sessionsRoot) {
	const real = realpathSync(dirPath);
	if (!isInside(realpathSync(sessionsRoot), real)) {
		throw new Error("refusing to remove a path outside the sessions root");
	}
	rmSync(real, { recursive: true, force: false });
}

/**
 * Best-effort projection-cache scrub: the aggregate index
 * (`<dshHome>/storages/session_projcache.json`) plus the per-session file
 * (`<dshHome>/storages/session_projcache/sessions/<id>.json`). Both spellings
 * of the id are handled. A stale entry here is cosmetic, so every failure is
 * swallowed — the harness owns these files and will reconcile anyway.
 * @param home - absolute harness home.
 * @param ids - session ids whose cache rows are dropped.
 */
function scrubProjcache(home, ids) {
	const keysBy = (id) => [id, id.replace(/^session-/, "")];
	const indexPath = join(home, "storages", "session_projcache.json");
	try {
		if (existsSync(indexPath)) {
			const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
			const sessions = parsed?.tables?.sessions;
			if (sessions !== void 0 && sessions !== null) {
				let touched = false;
				for (const id of ids) {
					for (const key of keysBy(id)) {
						if (Object.prototype.hasOwnProperty.call(sessions, key)) {
							delete sessions[key];
							touched = true;
						}
					}
				}
				if (touched) writeFileSync(indexPath, JSON.stringify(parsed, null, 2), "utf8");
			}
		}
	} catch {
		// A corrupt index is left alone; the harness owns it.
	}
	const perSessionDir = join(home, "storages", "session_projcache", "sessions");
	for (const id of ids) {
		for (const key of keysBy(id)) {
			const file = join(perSessionDir, `${key}.json`);
			try {
				if (existsSync(file)) unlinkSync(file);
			} catch {
				// Same best-effort contract.
			}
		}
	}
}

export { canonicalSessionId, dshHome, findSessionDir, isInside, isSafeSessionId, removeSessionDir, scrubProjcache };

