/**
 * Service-level test for the physical-delete path.
 *
 * Loads the real host entry (with its cordis/z/workspace imports stubbed by
 * stub-loader.mjs), stands up a throwaway DSH_HOME with one archived session,
 * and drives `ArchiveManagerService.delete()` with mock storage/registry
 * services. This is the layer the pure-function suite cannot reach: the
 * `join is not defined` regression shipped past it because a missing runtime
 * import only throws when the method actually runs.
 *
 * Run with: node delete-service-test.mjs
 */
import { register } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;
const lines = [];

function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) passed += 1;
	else failed += 1;
	lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

register(new URL("./stub-loader.mjs", import.meta.url));

const home = mkdtempSync(join(tmpdir(), "dsh-am-service-"));
process.env.DSH_HOME = home;

const { ArchiveManagerService } = await import("./lib/index.js");

const sessionId = "session-aaaa1111-2222-3333-4444-555566667777";
const otherId = "session-bbbb1111-2222-3333-4444-555566667777";
const sessionDir = join(home, "sessions", "--C-Users-test-Project--", sessionId);
const otherDir = join(home, "sessions", "--C-Users-test-Project--", otherId);
mkdirSync(sessionDir, { recursive: true });
mkdirSync(otherDir, { recursive: true });
writeFileSync(join(sessionDir, "session.v3.jsonl.zstd"), "bytes");
writeFileSync(join(otherDir, "session.v3.jsonl.zstd"), "bytes");
mkdirSync(join(home, "storages", "session_projcache", "sessions"), { recursive: true });
writeFileSync(join(home, "storages", "session_projcache.json"), JSON.stringify({ tables: { sessions: { [sessionId]: {}, [otherId]: {} } } }), "utf8");
writeFileSync(join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`), "{}", "utf8");

/** Fresh mock composition per call, so one case cannot leak into the next. */
function makeService(archivedIds) {
	const state = { archivedSessionIds: [...archivedIds], workspaces: [] };
	const domain = {
		global: {
			get: () => state,
			set: async (next) => Object.assign(state, next)
		}
	};
	const registry = {
		state,
		setState: async (next) => Object.assign(state, next),
		enqueueOperation: async (fn) => fn(),
		list: () => []
	};
	const ctx = {
		storageDomain: { get: (name) => (name === "workspace" ? domain : undefined) },
		workspaceRegistry: registry
	};
	return { service: new ArchiveManagerService(ctx, { enabled: true }), state };
}

// 1. A session that is NOT archived must be refused and left untouched.
{
	const { service } = makeService([otherId]);
	const result = await service.delete(sessionId);
	check("未归档的会话被拒绝", result.ok, false);
	check("拒绝原因可读", typeof result.error === "string" && result.error.length > 0, true);
	check("被拒绝时目录未被删", existsSync(sessionDir), true);
}

// 2. The happy path: an archived session is removed from disk, from the
//    archive set, and from the projection cache.
{
	const { service, state } = makeService([sessionId, otherId]);
	const result = await service.delete(sessionId);
	check("已归档会话删除成功", result.ok, true);
	check("removedDir 为真", result.removedDir, true);
	check("会话目录被物理删除", existsSync(sessionDir), false);
	check("逐会话缓存文件被删除", existsSync(join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`)), false);
	check("归档集合只剩另一条", state.archivedSessionIds, [otherId]);
	check("无关会话目录保留", existsSync(otherDir), true);
}

// 3. Bare-uuid spelling in the archive set must still resolve and delete.
{
	const bareDir = join(home, "sessions", "--C-Users-test-Project--", "cccc1111-2222-3333-4444-555566667777");
	mkdirSync(bareDir, { recursive: true });
	writeFileSync(join(bareDir, "session.v3.jsonl.zstd"), "bytes");
	const bareId = "cccc1111-2222-3333-4444-555566667777";
	const { service } = makeService([bareId]);
	const result = await service.delete(bareId);
	check("裸 uuid 拼写也能删除", result.ok, true);
	check("裸 uuid 目录被删除", existsSync(bareDir), false);
}

// 4. A malformed id is refused before any filesystem work.
{
	const { service } = makeService(["../../etc"]);
	const result = await service.delete("../../etc");
	check("畸形 id 被拒绝", result.ok, false);
	check("畸形 id 的拒绝原因是 invalid sessionId", result.error, "invalid sessionId");
}

rmSync(home, { recursive: true, force: true });

lines.push("");
lines.push(`RESULT: ${failed === 0 ? "OK" : "FAIL"} — ${passed} passed, ${failed} failed`);
const report = lines.join("\n");
console.log(report);
process.exit(failed === 0 ? 0 : 1);
