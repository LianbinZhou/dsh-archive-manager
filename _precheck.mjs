// 预检脚本:验证 dsh-archive-manager 后端模块可正常加载
import { name, Config, apply, inject } from "file:///C:/Users/zhou0/DeepSeek_Harness_Projects/dsh-archive-manager/lib/index.js";

console.log("=== 模块加载成功 ===");
console.log("name:", name);
console.log("Config 类型:", typeof Config?.object);
console.log("apply 类型:", typeof apply);
console.log("inject:", JSON.stringify(inject));
