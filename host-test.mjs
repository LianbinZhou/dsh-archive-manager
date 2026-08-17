// 验证后端模块导出完整(相对导入,从所在目录解析)
import * as m from "./lib/index.js";
import { writeFileSync } from "node:fs";

const out = [
	"exports: " + Object.keys(m).join(", "),
	"apply 类型: " + typeof m.apply,
	"name: " + m.name,
	"inject: " + JSON.stringify(m.inject),
	typeof m.apply === "function" ? "RESULT: OK" : "RESULT: FAIL"
];
writeFileSync("C:/Users/zhou0/DeepSeek_Harness_Projects/_host_test.txt", out.join("\n"));
