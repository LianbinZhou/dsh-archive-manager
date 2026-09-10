/**
 * dsh-archive-manager — host (backend) half.
 *
 * Teaches the dsh web GUI a feature the official build does not ship:
 * un-archiving (restoring) a session back into the workspace list.
 *
 * How it works:
 *   1. The official `workspaceRegistry` service exposes `archivedSessionIds`
 *      (the hidden list) but no method to remove from it. This plugin reads
 *      the SAME durable storage domain the registry uses (workspace.json),
 *      removes the target id, and writes it back through the official
 *      `storageDomain` service — so the on-disk state is what the registry
 *      reloads on next boot, AND the registry's in-memory state is updated
 *      through its own write path where possible.
 *   2. It registers its own HTTP routes under /api/archive-manager/* so the
 *      browser half can list archived sessions and restore one.
 */

import { Service } from "@deepseek-ai/cordis";
import z from "schemastery";
import { workspaceDomainSpec } from "@deepseek-ai/dsh-workspace";

/** Stable plugin row name used in cordis.patch.yml. */
const name = "archive-manager";

/** Services required before the archive surfaces can mount. */
const inject = ["webServer", "storageDomain", "workspaceRegistry", "sessionPersistence"];

const ROUTE_PREFIX = "/api/archive-manager";

/** Re-check interval for an archived session whose log holds no title yet. */
const TITLE_MISS_TTL_MS = 30_000;

/** Plugin config (schema defaults applied by the loader). */
const Config = z.object({
	enabled: z.boolean().default(true)
});

/** JSON body read helper (route handlers receive raw node req/res). */
function readBody(req) {
	return new Promise((resolveBody, rejectBody) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > 1_000_000) {
				rejectBody(new Error("body too large"));
				req.destroy();
			}
		});
		req.on("end", () => {
			try {
				resolveBody(JSON.parse(data || "{}"));
			} catch (error) {
				rejectBody(error);
			}
		});
		req.on("error", rejectBody);
	});
}

/** Send a JSON response. */
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(payload);
}

/**
 * The plugin's single service: a thin wrapper over the workspace storage
 * domain with the two operations the GUI needs.
 */
class ArchiveManagerService extends Service {
	static inject = ["storageDomain", "workspaceRegistry"];

	constructor(ctx, config) {
		super(ctx, "archiveManager");
		this.config = config;
		this._domainPromise = null;
		/** Resolved title rows, keyed by session id (see `_titleEntry`). */
		this._titleCache = new Map();
		/** In-flight batch title read, so overlapping polls share one pass. */
		this._titleJob = null;
	}

	/** Open (once) the exact durable domain the workspace registry uses. */
	async _domain() {
		if (this._domainPromise === null) {
			// The official workspaceRegistry already opens this domain at boot;
			// re-opening it throws already-open. Reuse the live handle instead.
			const existing = this.ctx.storageDomain.get?.("workspace");
			this._domainPromise = existing !== undefined
				? Promise.resolve(existing)
				: this.ctx.storageDomain.open(workspaceDomainSpec);
		}
		return this._domainPromise;
	}

	/** List archived session ids with their real titles (from the session log). */
	async list() {
		const domain = await this._domain();
		const state = domain.global.get();
		const archived = (state?.archivedSessionIds ?? []).map((id) => String(id));
		await this._ensureTitles(archived);
		// Drop cached rows for sessions that are no longer archived, so the map
		// cannot grow without bound as sessions are restored and re-archived.
		const live = new Set(archived);
		for (const cachedId of [...this._titleCache.keys()]) {
			if (!live.has(cachedId)) this._titleCache.delete(cachedId);
		}
		const items = archived.map((sessionId) => {
			const entry = this._titleEntry(sessionId);
			if (entry === void 0 || entry.title === void 0) return { sessionId };
			return entry.updatedAt === void 0
				? { sessionId, title: entry.title }
				: { sessionId, title: entry.title, updatedAt: entry.updatedAt };
		});
		return { archivedSessionIds: [...archived], items };
	}

	/**
	 * Read one cached title row, honouring the negative-cache TTL.
	 *
	 * A session that HAS a title is cached for the life of the process: an
	 * archived session's log is not written to any more. A session that has no
	 * title yet (a brand-new session archived before its title landed) is
	 * re-checked after `TITLE_MISS_TTL_MS`.
	 * @param sessionId - archived session id.
	 * @returns the cached row, or undefined when nothing is cached (or a miss expired).
	 */
	_titleEntry(sessionId) {
		const entry = this._titleCache.get(sessionId);
		if (entry === void 0) return void 0;
		if (entry.title === void 0 && Date.now() - entry.at > TITLE_MISS_TTL_MS) {
			this._titleCache.delete(sessionId);
			return void 0;
		}
		return entry;
	}

	/**
	 * Make sure every requested id has a cache row, reading only the missing ones.
	 *
	 * Reads are serialized behind `_titleJob`: the list route is polled by the
	 * browser panel, and two overlapping polls must not decompress the same
	 * session logs twice. A caller that arrives while a batch is in flight waits
	 * for it and then resolves whatever ids that batch did not cover.
	 * @param ids - archived session ids to resolve.
	 */
	async _ensureTitles(ids) {
		if (this._titleJob !== null) await this._titleJob;
		const missing = ids.filter((id) => this._titleEntry(id) === void 0);
		if (missing.length === 0) return;
		let settle;
		this._titleJob = new Promise((resolve) => {
			settle = resolve;
		});
		try {
			await this._resolveTitles(missing);
		} finally {
			this._titleJob = null;
			settle();
		}
	}

	/**
	 * Resolve titles for a batch of ids into the cache, fail-soft per id.
	 *
	 * Two official read paths, newest first:
	 *   1. `ctx.sessionQuery.readTitleSnapshots` — the current documented fold for
	 *      non-live (archived) sessions, and one corpus listing for the whole batch.
	 *   2. The raw log — `sessionPersistence.open(id, 'read')` plus a manual fold of
	 *      the newest `session/title` event, for compositions without sessionQuery.
	 * Both are best-effort: an id that resolves through neither simply renders as
	 * a bare session id instead of failing the whole list.
	 * @param ids - ids with no usable cache row.
	 */
	async _resolveTitles(ids) {
		const pending = new Set(ids);
		const query = this._sessionQuery();
		if (query !== void 0 && typeof query.readTitleSnapshots === "function") {
			try {
				const results = await query.readTitleSnapshots(ids);
				for (const result of results ?? []) {
					if (result?.status !== "fulfilled") continue;
					const title = result.value?.title;
					if (typeof title?.title !== "string" || title.title.length === 0) continue;
					this._cacheTitle(String(result.sessionId), title.title, title.updatedAt);
					pending.delete(String(result.sessionId));
				}
			} catch {
				// Fall through: the per-id paths below still get a chance.
			}
		}
		for (const sessionId of [...pending]) {
			const single = await this._titleOf(sessionId);
			if (single !== void 0) this._cacheTitle(sessionId, single.title, single.updatedAt);
			else this._cacheMiss(sessionId);
		}
	}

	/** Store one resolved title row. */
	_cacheTitle(sessionId, title, updatedAt) {
		this._titleCache.set(sessionId, {
			title,
			updatedAt: typeof updatedAt === "number" ? updatedAt : void 0,
			at: Date.now()
		});
	}

	/** Store one "checked, no title" row (expires after the miss TTL). */
	_cacheMiss(sessionId) {
		if (this._titleCache.has(sessionId)) return;
		this._titleCache.set(sessionId, { title: void 0, updatedAt: void 0, at: Date.now() });
	}

	/** The optional title service; absent in compositions without session-query. */
	_sessionQuery() {
		try {
			return this.ctx.get?.("sessionQuery") ?? this.ctx.sessionQuery;
		} catch {
			return void 0;
		}
	}

	/** Resolve one session's title, fail-soft: sessionQuery, then the raw log. */
	async _titleOf(sessionId) {
		const query = this._sessionQuery();
		if (query !== void 0 && typeof query.readTitle === "function") {
			try {
				const snapshot = await query.readTitle(sessionId);
				if (typeof snapshot?.title === "string" && snapshot.title.length > 0) {
					return { title: snapshot.title, updatedAt: snapshot.updatedAt };
				}
			} catch {
				// Fall through to the raw-log path.
			}
		}
		return await this._titleFromLog(sessionId);
	}

	/**
	 * Raw-log fallback: open the stored session read-only and fold the newest
	 * `session/title` event. `inspect()` (the pre-0.1.5 shortcut this plugin used)
	 * no longer exists, so the log is read through an ordinary read handle.
	 * @param sessionId - session whose log is folded.
	 * @returns the title and its event timestamp, or undefined.
	 */
	async _titleFromLog(sessionId) {
		let handle;
		try {
			const persistence = this.ctx.sessionPersistence;
			if (persistence === void 0 || typeof persistence.open !== "function") return void 0;
			handle = await persistence.open(sessionId, "read");
			const loaded = await handle.read();
			const events = loaded?.events;
			if (!Array.isArray(events)) return void 0;
			for (let index = events.length - 1; index >= 0; index -= 1) {
				const event = events[index];
				if (event?.type !== "session/title") continue;
				const title = event.data?.title;
				if (typeof title !== "string" || title.length === 0) return void 0;
				return {
					title,
					updatedAt: typeof event.time === "number" ? event.time : void 0
				};
			}
			return void 0;
		} catch {
			return void 0;
		} finally {
			try {
				await handle?.close();
			} catch {
				// Releasing a read handle is best-effort; a failure changes no state.
			}
		}
	}

	/**
	 * Restore one session: remove it from the durable archive set.
	 * Uses the same write path the official registry uses (setState via the
	 * domain global), so both disk and the registry's in-memory snapshot are
	 * updated — the session reappears in the sidebar without a restart.
	 */
	async unarchive(sessionId) {
		const domain = await this._domain();
		const registry = this.ctx.workspaceRegistry;
		const state = domain.global.get();
		const archived = state?.archivedSessionIds ?? [];
		if (!archived.includes(sessionId)) {
			return { ok: true, already: true };
		}
		const next = archived.filter((id) => id !== sessionId);
		// Write through the registry's own enqueue path when available so the
		// in-memory snapshot stays consistent with disk immediately. The
		// registry state carries the archived set the api-proxy frame watcher
		// compares, so it MUST go through setState (not a bare global.set) for
		// the browser to learn of the change without a reload.
		if (registry && typeof registry.enqueueOperation === "function") {
			await registry.enqueueOperation(async () => {
				if (typeof registry.setState === "function" && registry.state !== void 0) {
					await registry.setState({
						...registry.state,
						archivedSessionIds: next
					});
				} else {
					await domain.global.set({
						...domain.global.get(),
						archivedSessionIds: next
					});
				}
			});
		} else {
			await domain.global.set({
				...state,
				archivedSessionIds: next
			});
		}
		return { ok: true, archivedSessionIds: next };
	}
}

/** Register the plugin: routes. */
function apply(ctx, config) {
	const service = new ArchiveManagerService(ctx, config);

	// Route wiring — the browser half talks to these exact paths.
	// IMPORTANT: ctx.effect callback must return a disposer function (or
	// undefined); returning an array throws "Invalid effect" in cordis.
	const routes = [
		{
			kind: "exact",
			path: `${ROUTE_PREFIX}/list`,
			handler: async (req, res) => {
				if (req.method !== "GET" && req.method !== "POST") {
					sendJson(res, 405, { error: "method not allowed" });
					return;
				}
				try {
					const result = await service.list();
					sendJson(res, 200, result);
				} catch (error) {
					sendJson(res, 500, { error: String(error?.message ?? error) });
				}
			}
		},
		{
			kind: "exact",
			path: `${ROUTE_PREFIX}/unarchive`,
			handler: async (req, res) => {
				if (req.method !== "POST") {
					sendJson(res, 405, { error: "method not allowed" });
					return;
				}
				try {
					const body = await readBody(req);
					const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
					if (sessionId === null || sessionId.length === 0) {
						sendJson(res, 400, { error: "missing sessionId" });
						return;
					}
					const result = await service.unarchive(sessionId);
					sendJson(res, 200, result);
				} catch (error) {
					sendJson(res, 500, { error: String(error?.message ?? error) });
				}
			}
		}
	];

	ctx.effect(() => {
		const disposers = routes.map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "archive-manager: routes");
}

export { ArchiveManagerService, Config, apply, inject, name }; 
