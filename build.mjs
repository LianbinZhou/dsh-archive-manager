/**
 * One-shot build for dsh-archive-manager.
 *
 *   node build.mjs
 *
 * - `src/host/*.js`      -> `lib/*.js` (the host half ships as plain ESM)
 * - `src/client/client.js` -> `lib/client.js` (wrapped in the `__ModuleLoader__`
 *   envelope the DSH web shell expects)
 *
 * All I/O goes through Node itself, so UTF-8 is byte-exact and there is no
 * shell encoding pitfall to trip over.
 */
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const hostSrc = join(root, "src", "host");
const lib = join(root, "lib");

for (const entry of readdirSync(hostSrc)) {
	if (!entry.endsWith(".js")) continue;
	copyFileSync(join(hostSrc, entry), join(lib, entry));
	console.log(`lib/${entry} 已生成`);
}

const src = readFileSync(join(root, "src", "client", "client.js"), "utf8");

// 去掉文件头的 JSDoc 注释,并把 export function apply 换成普通 function apply
const body = src
	.replace(/^\/\*\*[\s\S]*?\*\//, "")
	.replace("export function apply", "function apply");

const wrapper = `window.__ModuleLoader__.load({
	id: "dsh-archive-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
`;

writeFileSync(join(lib, "client.js"), wrapper, "utf8");
console.log("lib/client.js 已生成:", wrapper.length, "bytes");
