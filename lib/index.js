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
		const archived = state?.archivedSessionIds ?? [];
		const items = [];
		for (const id of archived) items.push({ sessionId: id, title: await this._titleOf(id) });
		return { archivedSessionIds: [...archived], items };
	}

	/** Resolve one session's title from its log (`session/title` event), fail-soft. */
	async _titleOf(sessionId) {
		try {
			const persistence = this.ctx.sessionPersistence;
			if (persistence === void 0 || typeof persistence.inspect !== "function") return void 0;
			const loaded = await persistence.inspect(sessionId);
			const events = loaded?.events;
			if (!Array.isArray(events)) return void 0;
			for (let index = events.length - 1; index >= 0; index -= 1) {
				const event = events[index];
				if (event?.type === "session/title") return event.data?.title;
			}
			return void 0;
		} catch {
			return void 0;
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
