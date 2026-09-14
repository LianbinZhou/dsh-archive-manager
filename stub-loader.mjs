/**
 * Minimal ESM stub loader for the service-level delete test.
 *
 * `lib/index.js` imports the cordis/z-schema/workspace packages, which are
 * peer dependencies of a DSH composition and are not installed in this repo.
 * Stubbing them here lets the test import the real host entry and drive its
 * `delete()` method end to end, which is exactly the seam a missing runtime
 * import (the `join is not defined` regression) escapes a pure-function suite
 * through.
 */
const STUBS = {
	"@deepseek-ai/cordis": `
		export class Service {
			constructor(ctx, name) {
				this.ctx = ctx;
				this.name = name;
			}
		}
	`,
	schemastery: `
		const z = () => ({});
		z.object = (fields) => fields;
		z.boolean = () => ({ default: (value) => ({ type: "boolean", default: value }) });
		export default z;
	`,
	"@deepseek-ai/dsh-workspace": `
		export const workspaceDomainSpec = { name: "workspace" };
	`
};

export async function resolve(specifier, context, nextResolve) {
	if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) {
		return {
			url: `data:text/javascript;base64,${Buffer.from(STUBS[specifier]).toString("base64")}`,
			shortCircuit: true
		};
	}
	return nextResolve(specifier, context);
}
