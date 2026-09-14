/**
 * Local test suite for the physical-delete path helpers.
 *
 * Stands up a throwaway DSH_HOME on disk and pins the guarantees the delete
 * route depends on:
 *   1. session dir discovery covers both id spellings (bare uuid / prefixed);
 *   2. removal refuses any path outside `<home>/sessions`;
 *   3. a symlink that escapes the sessions root is never indexed nor removed;
 *   4. malformed ids are rejected before touching the filesystem;
 *   5. the projection-cache scrub drops the index row and the per-session file.
 *
 * Run with: node delete-test.mjs
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	canonicalSessionId,
	findSessionDir,
	isInside,
	isSafeSessionId,
	removeSessionDir,
	scrubProjcache
} from "./lib/paths.js";

let passed = 0;
let failed = 0;
const lines = [];

function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) passed += 1;
	else failed += 1;
	lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

function checkThrows(name, fn) {
	let threw = false;
	let message = "";
	try {
		fn();
	} catch (error) {
		threw = true;
		message = String(error?.message ?? error);
	}
	if (threw) passed += 1;
	else failed += 1;
	lines.push(`${threw ? "PASS" : "FAIL"}  ${name}${threw ? `  (refused: ${message})` : "  (did NOT refuse)"}`);
}

const home = mkdtempSync(join(tmpdir(), "dsh-archive-manager-test-"));
const sessionsRoot = join(home, "sessions");
const projectDir = join(sessionsRoot, "--C-Users-test-Project--");
const sessionId = "session-11111111-2222-3333-4444-555555555555";
const sessionDir = join(projectDir, sessionId);

function seed() {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "session.v3.jsonl.zstd"), "session-bytes");
	// Second spelling: a segment stored as the bare uuid.
	const bareId = "session-99999999-8888-7777-6666-555555555555";
	const bareDir = join(projectDir, bareId.replace(/^session-/, ""));
	mkdirSync(bareDir, { recursive: true });
	writeFileSync(join(bareDir, "session.v3.jsonl.zstd"), "bare-bytes");
	// Projection cache: aggregate index + per-session file.
	mkdirSync(join(home, "storages", "session_projcache", "sessions"), { recursive: true });
	writeFileSync(
		join(home, "storages", "session_projcache.json"),
		JSON.stringify({ tables: { sessions: { [sessionId]: { title: "t" }, "session-other": { title: "keep" } } } }),
		"utf8"
	);
	writeFileSync(join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`), "{}", "utf8");
}

seed();

// 1. id canonicalisation
check("canonicalSessionId(裸 uuid)", canonicalSessionId("11111111-2222-3333-4444-555555555555"), sessionId);
check("canonicalSessionId(已带前缀)", canonicalSessionId(sessionId), sessionId);

// 2. malformed ids are refused before any filesystem work
check("isSafeSessionId 正常 id", isSafeSessionId(sessionId), true);
check("isSafeSessionId 拒绝 ..", isSafeSessionId("../evil"), false);
check("isSafeSessionId 拒绝正斜杠", isSafeSessionId("a/b"), false);
check("isSafeSessionId 拒绝反斜杠", isSafeSessionId("a\\b"), false);
check("isSafeSessionId 拒绝空串", isSafeSessionId(""), false);
check("isSafeSessionId 拒绝超长", isSafeSessionId("x".repeat(300)), false);

// 3. discovery handles both spellings
check("findSessionDir(带前缀)", findSessionDir(sessionsRoot, sessionId), sessionDir);
check(
	"findSessionDir(裸 uuid 段)",
	findSessionDir(sessionsRoot, "session-99999999-8888-7777-6666-555555555555"),
	join(projectDir, "99999999-8888-7777-6666-555555555555")
);
check("findSessionDir(不存在的 id)", findSessionDir(sessionsRoot, "session-does-not-exist"), undefined);

// 4. removal refuses anything outside the sessions root
checkThrows("removeSessionDir 拒绝 sessions 根之外的路径", () => removeSessionDir(home, sessionsRoot));
// A path that is a sibling of the sessions root must also be refused.
const outsideSibling = join(home, "storages");
checkThrows("removeSessionDir 拒绝兄弟目录", () => removeSessionDir(outsideSibling, sessionsRoot));

// 5. isInside is lexical and separator-aware
check("isInside(自身)", isInside(sessionsRoot, sessionsRoot), true);
check("isInside(子路径)", isInside(sessionsRoot, sessionDir), true);
check("isInside(前缀相近但不是子路径)", isInside(sessionsRoot, `${sessionsRoot}-evil`), false);

// 6. a symlink escaping the sessions root is neither indexed nor removed
let skippedLink = false;
try {
	const escapeTarget = join(home, "outside-target");
	mkdirSync(escapeTarget, { recursive: true });
	writeFileSync(join(escapeTarget, "secret.txt"), "must-survive");
	symlinkSync(escapeTarget, join(projectDir, "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "junction");
	const found = findSessionDir(sessionsRoot, "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
	check("逃逸符号链接不被索引", found, undefined);
	check("逃逸目标文件仍在", existsSync(join(escapeTarget, "secret.txt")), true);
} catch (error) {
	skippedLink = true;
	lines.push(`SKIP  符号链接测试（当前环境无法创建链接: ${String(error?.message ?? error)}）`);
}

// 7. projection-cache scrub
scrubProjcache(home, [sessionId]);
const indexAfter = JSON.parse(readFileSync(join(home, "storages", "session_projcache.json"), "utf8"));
check("投影缓存索引已删除目标 id", sessionId in indexAfter.tables.sessions, false);
check("投影缓存索引保留了无关 id", "session-other" in indexAfter.tables.sessions, true);
check("投影缓存单文件已删除", existsSync(join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`)), false);

// 8. real removal of a discovered directory
removeSessionDir(sessionDir, sessionsRoot);
check("会话目录已物理删除", existsSync(sessionDir), false);
check("sessions 根仍然存在", existsSync(sessionsRoot), true);

// 9. corrupt projection index must not throw
writeFileSync(join(home, "storages", "session_projcache.json"), "{ not json", "utf8");
let corruptThrew = false;
try {
	scrubProjcache(home, [sessionId]);
} catch {
	corruptThrew = true;
}
check("损坏的投影索引被安全忽略", corruptThrew, false);

rmSync(home, { recursive: true, force: true });

lines.push("");
lines.push(`RESULT: ${failed === 0 ? "OK" : "FAIL"} — ${passed} passed, ${failed} failed${skippedLink ? ", 1 skipped" : ""}`);
const report = lines.join("\n");
writeFileSync(new URL("./_delete_test.txt", import.meta.url), report, "utf8");
console.log(report);
process.exit(failed === 0 ? 0 : 1);
