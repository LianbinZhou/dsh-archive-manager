// 构建脚本:把 src/client/client.js 包装成 __ModuleLoader__ 格式
// 用 Node 处理,保证 UTF-8 字节级正确(避免 PowerShell 编码坑)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = "C:/Users/zhou0/DeepSeek_Harness_Projects/dsh-archive-manager";
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

writeFileSync(join(root, "lib", "client.js"), wrapper, "utf8");
console.log("lib/client.js 已生成:", wrapper.length, "bytes");
