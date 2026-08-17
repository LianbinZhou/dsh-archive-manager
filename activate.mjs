// 把 dsh-archive-manager 加回 bundles(无 BOM,不经过 pnpm)
import { readFileSync, writeFileSync } from "node:fs";

const p = "C:/Users/zhou0/.dsh/profiles/web/package.json";
let raw = readFileSync(p, "utf8");
raw = raw.replace(/^\uFEFF/, "");
const j = JSON.parse(raw);
if (!j.dsh.profile.bundles.includes("dsh-archive-manager")) {
	j.dsh.profile.bundles.push("dsh-archive-manager");
}
writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
console.log("OK bundles:", j.dsh.profile.bundles.join(", "));
