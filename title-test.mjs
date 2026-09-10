// 标题解析离线测试:不启动 dsh,用 vm + 桩服务验证 list() 的标题解析链。
//
// 覆盖:
//   1. sessionQuery.readTitleSnapshots 正常 -> 直接拿到标题(+时间戳)
//   2. 批量里单条 rejected          -> 该条回退到原始日志
//   3. sessionQuery 整体抛错        -> 全部回退到原始日志 open/read 折叠
//   4. 多条 session/title 事件      -> 取最新一条
//   5. 无标题                       -> items 里不带 title 字段
//   6. 缓存                         -> 第二次 list 不再重复读日志
//   7. read handle                  -> 每次 open 都被 close
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const LIB = "C:/Users/zhou0/DeepSeek_Harness_Projects/dsh-archive-manager/lib/index.js";

/** 把 ESM 源码换成可用 vm 直接跑的形式(替换失败就报错,避免静默假通过)。 */
function loadServiceClass() {
	let code = readFileSync(LIB, "utf8");
	const swaps = [
		['import { Service } from "@deepseek-ai/cordis";', "const { Service } = __stubs.cordis;"],
		['import z from "schemastery";', "const z = __stubs.z;"],
		[
			'import { workspaceDomainSpec } from "@deepseek-ai/dsh-workspace";',
			"const { workspaceDomainSpec } = __stubs.workspace;"
		],
		[
			"export { ArchiveManagerService, Config, apply, inject, name };",
			"Object.assign(__out, { ArchiveManagerService, Config, apply, inject, name });"
		]
	];
	for (const [from, to] of swaps) {
		if (!code.includes(from)) throw new Error("源码结构与测试预期不符,未找到: " + from);
		code = code.replace(from, to);
	}
	const out = {};
	const stubs = {
		cordis: { Service: class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name; } } },
		z: { object: (shape) => shape, boolean: () => ({ default: () => true }) },
		workspace: { workspaceDomainSpec: { name: "workspace" } }
	};
	const sandbox = { __stubs: stubs, __out: out, console };
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox);
	return out.ArchiveManagerService;
}

/** 假持久化后端:每个 id 一段日志,并统计 open/read/close 次数。 */
function fakePersistence(logs) {
	const stats = { open: 0, read: 0, close: 0, openedOk: 0 };
	return {
		stats,
		async open(id, access) {
			stats.open += 1;
			const events = logs[id];
			if (events === void 0) throw new Error("not found: " + id);
			if (access !== "read") throw new Error("test backend only serves read handles");
			stats.openedOk += 1;
			return {
				id,
				access,
				async read() {
					stats.read += 1;
					return { events };
				},
				async close() {
					stats.close += 1;
				}
			};
		}
	};
}

/** 造一个最小 ctx:storageDomain 提供归档 id 列表,其余服务按需注入。 */
function fakeCtx(archived, { persistence, query } = {}) {
	const domain = {
		global: { get: () => ({ archivedSessionIds: archived }) }
	};
	return {
		storageDomain: { get: () => domain },
		sessionPersistence: persistence,
		sessionQuery: query,
		get(name) {
			return name === "sessionQuery" ? query : void 0;
		}
	};
}

/** 绕开 cordis 构造:直接造实例并填好私有字段。 */
function makeService(ServiceClass, ctx) {
	const service = Object.create(ServiceClass.prototype);
	service.ctx = ctx;
	service.config = { enabled: true };
	service._domainPromise = null;
	service._titleCache = new Map();
	service._titleJob = null;
	return service;
}

const results = [];
let failures = 0;
function check(name, ok, detail) {
	results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail === void 0 ? "" : "  -> " + detail}`);
	if (!ok) failures += 1;
}

const ServiceClass = loadServiceClass();

// —— 用例 1/2/5:批量接口命中 + 单条 rejected 回退 + 无标题 ——
{
	const logs = {
		"session-a": [{ type: "session/title", time: 111, data: { title: "日志里的旧标题" } }],
		"session-b": [{ type: "session/title", time: 333, data: { title: "日志里的旧标题" } }]
	};
	const persistence = fakePersistence(logs);
	const query = {
		async readTitleSnapshots(ids) {
			return ids.map((id) => {
				if (id === "session-a") {
					return {
						sessionId: id,
						status: "fulfilled",
						value: { session: { id }, title: { title: "整理照片归档流程", updatedAt: 222 } }
					};
				}
				if (id === "session-b") {
					return { sessionId: id, status: "rejected", reason: new Error("boom") };
				}
				return { sessionId: id, status: "fulfilled", value: { session: { id } } };
			});
		}
	};
	const service = makeService(ServiceClass, fakeCtx(["session-a", "session-b", "session-c"], { persistence, query }));
	const data = await service.list();
	const byId = new Map(data.items.map((item) => [item.sessionId, item]));
	check("批量接口标题透传", byId.get("session-a")?.title === "整理照片归档流程", byId.get("session-a")?.title);
	check("批量接口时间戳透传", byId.get("session-a")?.updatedAt === 222, String(byId.get("session-a")?.updatedAt));
	check("rejected 单条回退到日志", byId.get("session-b")?.title === "日志里的旧标题", byId.get("session-b")?.title);
	check("无标题条目只剩 sessionId", Object.keys(byId.get("session-c") ?? {}).join(",") === "sessionId", JSON.stringify(byId.get("session-c")));
	check("命中的条目不重复读日志", persistence.stats.open === 2, "open=" + persistence.stats.open);
	check("读句柄被释放", persistence.stats.close === persistence.stats.openedOk && persistence.stats.openedOk === 1, `open=${persistence.stats.open} openedOk=${persistence.stats.openedOk} close=${persistence.stats.close}`);
}

// —— 用例 3/4:没有 sessionQuery 时全量回退,且取最新一条 title 事件 ——
{
	const logs = {
		"session-x": [
			{ type: "user/message", time: 1, data: {} },
			{ type: "session/title", time: 10, data: { title: "第一个标题" } },
			{ type: "user/message", time: 20, data: {} },
			{ type: "session/title", time: 30, data: { title: "最后改过的标题" } }
		],
		"session-y": [{ type: "session/title", time: 40, data: { title: "" } }]
	};
	const persistence = fakePersistence(logs);
	const service = makeService(ServiceClass, fakeCtx(["session-x", "session-y"], { persistence }));
	const data = await service.list();
	const byId = new Map(data.items.map((item) => [item.sessionId, item]));
	check("无 sessionQuery 时回退日志折叠", byId.get("session-x")?.title === "最后改过的标题", byId.get("session-x")?.title);
	check("回退路径也带时间戳", byId.get("session-x")?.updatedAt === 30, String(byId.get("session-x")?.updatedAt));
	check("空标题按无标题处理", byId.get("session-y")?.title === void 0 && "title" in byId.get("session-y") === false, JSON.stringify(byId.get("session-y")));
}

// —— 用例 3b:sessionQuery 抛错时整批回退到日志 ——
{
	const logs = { "session-z": [{ type: "session/title", time: 7, data: { title: "日志兜底标题" } }] };
	const persistence = fakePersistence(logs);
	const query = {
		async readTitleSnapshots() {
			throw new Error("session-query 挂了");
		},
		async readTitle() {
			throw new Error("session-query 挂了");
		}
	};
	const service = makeService(ServiceClass, fakeCtx(["session-z"], { persistence, query }));
	const data = await service.list();
	check("批量接口抛错后回退日志", data.items[0]?.title === "日志兜底标题", data.items[0]?.title);
}

// —— 用例 6:缓存生效,第二次 list 不再读日志 ——
{
	const logs = { "session-cache": [{ type: "session/title", time: 5, data: { title: "缓存标题" } }] };
	const persistence = fakePersistence(logs);
	const service = makeService(ServiceClass, fakeCtx(["session-cache"], { persistence }));
	const first = await service.list();
	const opensAfterFirst = persistence.stats.open;
	const second = await service.list();
	const third = await service.list();
	check("首次解析拿到标题", first.items[0]?.title === "缓存标题", first.items[0]?.title);
	check("后续 list 不再读日志", persistence.stats.open === opensAfterFirst, `第一次后 open=${opensAfterFirst}, 第三次后 open=${persistence.stats.open}`);
	check("缓存命中结果一致", second.items[0]?.title === "缓存标题" && third.items[0]?.title === "缓存标题");
}

// —— 用例 7:会话日志不存在时不影响其他条目 ——
{
	const logs = { "session-ok": [{ type: "session/title", time: 9, data: { title: "存在的会话" } }] };
	const persistence = fakePersistence(logs);
	const service = makeService(ServiceClass, fakeCtx(["session-ok", "session-gone"], { persistence }));
	const data = await service.list();
	const byId = new Map(data.items.map((item) => [item.sessionId, item]));
	check("缺失会话不炸整批", data.items.length === 2 && byId.get("session-ok")?.title === "存在的会话", JSON.stringify(data.items));
	check("缺失会话只留 id", byId.get("session-gone")?.title === void 0 && Object.keys(byId.get("session-gone")).length === 1);
}

// —— 用例 8:并发 list 只触发一轮日志读取 ——
{
	const logs = { "session-p": [{ type: "session/title", time: 3, data: { title: "并发标题" } }] };
	const persistence = fakePersistence(logs);
	const service = makeService(ServiceClass, fakeCtx(["session-p"], { persistence }));
	const [a, b] = await Promise.all([service.list(), service.list()]);
	check("并发调用共享一次解析", persistence.stats.open === 1, "open=" + persistence.stats.open);
	check("并发两条结果都带标题", a.items[0]?.title === "并发标题" && b.items[0]?.title === "并发标题");
}

const report = results.join("\n") + `\n\n合计: ${results.length - failures}/${results.length} 通过`;
writeFileSync("C:/Users/zhou0/DeepSeek_Harness_Projects/_title_test.txt", report, "utf8");
console.log(report);
process.exitCode = failures === 0 ? 0 : 1;
