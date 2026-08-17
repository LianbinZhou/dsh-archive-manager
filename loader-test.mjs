// 模拟 __ModuleLoader__ 加载前端 bundle,验证 apply 可获取
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(
	"C:/Users/zhou0/DeepSeek_Harness_Projects/dsh-archive-manager/lib/client.js",
	"utf8"
);

const results = {};
const loader = {
	load: (handoff) => {
		results.factory = handoff.factory;
	}
};

const sandbox = {
	window: { __ModuleLoader__: loader },
	document: {
		querySelector: () => null,
		querySelectorAll: () => [],
		createElement: () => ({ appendChild: () => {}, classList: { add: () => {} } }),
		head: { appendChild: () => {} },
		body: {},
		addEventListener: () => {},
		removeEventListener: () => {},
		documentElement: { removeAttribute: () => {}, setAttribute: () => {} },
		dispatchEvent: () => {}
	},
	MutationObserver: function () {
		return { observe: () => {}, disconnect: () => {} };
	},
	CustomEvent: function () {},
	fetch: () => Promise.resolve({ json: () => Promise.resolve({}) })
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const out = [];
if (typeof results.factory !== "function") {
	out.push("FAIL: 未注册 factory");
} else {
	const exportsObj = results.factory((s) => {
		throw new Error("require called: " + s);
	});
	out.push("factory 返回类型: " + typeof exportsObj);
	out.push("exports.apply: " + typeof exportsObj?.apply);
	out.push("exports.inject: " + JSON.stringify(exportsObj?.inject));
	out.push(
		typeof exportsObj?.apply === "function"
			? "RESULT: OK 加载器能拿到 apply"
			: "RESULT: FAIL apply 为 undefined"
	);
}
writeFileSync("C:/Users/zhou0/DeepSeek_Harness_Projects/_loader_test.txt", out.join("\n"));
