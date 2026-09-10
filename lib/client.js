window.__ModuleLoader__.load({
	id: "dsh-archive-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });


const ACTIVE_ATTR = "data-dsh-archive-active";
const OTHER_ACTIVE_ATTRS = ["data-dsh-ssh-active", "data-dsh-taskboard-active"];
const ACTIVATE_EVENT = "dsh-panel-activate";
const PANEL_NAME = "archive";

const SIDEBAR_SELECTOR = "[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]";
const CONVERSATION_SELECTOR = "[data-pane=\"conversation\"], [class*=\"centerCol\"]";

/** Inject the stylesheet that shows/hides our panel. */
function injectStyles(tagId) {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return;
	const style = document.createElement("style");
	style.dataset.pluginCss = tagId;
	style.textContent = `
		[data-pane=conversation],[class*=centerCol]{position:relative}
		[data-dsh-archive-view]{z-index:59;background:var(--dsw-alias-bg-base);display:none;position:absolute;inset:0}
		html[data-dsh-archive-active] [data-dsh-archive-view]{display:flex;flex-direction:column;gap:10px;padding:14px 16px}
		html[data-dsh-archive-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [data-pane=conversation]>:not([data-dsh-archive-view]),
		html[data-dsh-archive-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [class*=centerCol]>:not([data-dsh-archive-view]){display:none!important}
		.dsham-entry{width:100%;height:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:0 12px;font-size:13px;display:flex}
		.dsham-entry:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary)}
		.dsham-entry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary);font-weight:600}
		.dsham-entryIcon{flex:none;justify-content:center;align-items:center;display:inline-flex}
		.dsham-entryLabel{text-overflow:ellipsis;overflow:hidden}
		[data-dsh-frame][data-sidebar-collapsed] .dsham-entry{justify-content:center;width:100%;padding:0}
		[data-dsh-frame][data-sidebar-collapsed] .dsham-entryLabel{display:none}
		.dsham-title{margin:0;font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary)}
		.dsham-empty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:28px 12px;font-size:13px}
		.dsham-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;cursor:default}
		.dsham-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
		.dsham-itemTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px}
		.dsham-itemTime{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
		.dsham-restore{flex:none;color:var(--dsw-alias-state-business-primary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
		.dsham-restore:hover{background:var(--dsw-alias-interactive-bg-hover)}
		.dsham-list{display:flex;flex-direction:column;gap:2px;overflow-y:auto}
		.dsham-status{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
	`;
	document.head.appendChild(style);
}

/** Tiny state holder: is the panel open? */
function createController() {
	let open = false;
	const listeners = new Set();
	return {
		getSnapshot: () => ({ open }),
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		toggle() {
			open = !open;
			for (const fn of [...listeners]) fn();
		},
		close() {
			if (!open) return;
			open = false;
			for (const fn of [...listeners]) fn();
		}
	};
}

/** Sidebar root element (or undefined before the shell mounts). */
function sidebarRoot() {
	const column = document.querySelector(SIDEBAR_SELECTOR);
	if (column === null) return void 0;
	return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
}

/** The New Session button — our entry lands right after it. */
function newSessionButton(root) {
	const nested = root.querySelector("button[class*=\"newSession\"]");
	if (nested !== null) return nested;
	for (const child of root.children) if (child.tagName === "BUTTON") return child;
}

/** Build the sidebar entry button (detached; inserted once the shell is up). */
function createEntry(controller) {
	const entry = document.createElement("button");
	entry.type = "button";
	entry.dataset.dshArchiveEntry = "";
	entry.className = "dsham-entry";
	entry.setAttribute("aria-label", "历史归档");
	entry.setAttribute("title", "历史归档");
	entry.innerHTML = `<span class="dsham-entryIcon"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11M4 4.5V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.5M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M6 8h4"/></svg></span><span class="dsham-entryLabel">历史归档</span>`;
	entry.addEventListener("click", () => controller.toggle());
	return entry;
}

/** Insert the entry after the New Session row (before the browser region). */
function placeEntry(root, entry) {
	const button = newSessionButton(root);
	if (button === void 0) return false;
	if (entry.parentElement !== root) {
		const row = button.closest("[class*=\"logoRow\"]");
		const base = row !== null && row.parentElement === root ? row : button;
		const family = Array.from(root.children).filter((el) => el instanceof HTMLElement && el.matches("[data-dsh-archive-entry], [data-dsh-ssh-entry], [data-dsh-taskboard-entry]"));
		const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
		root.insertBefore(entry, anchor);
	}
	return true;
}

/** Center column (or undefined). */
function conversationColumn() {
	return document.querySelector(CONVERSATION_SELECTOR) ?? void 0;
}

/** Short label for an archived session: title or id tail. */
function labelFor(meta) {
	if (meta?.title && meta.title.length > 0) return meta.title;
	if (typeof meta?.sessionId === "string") return `未取到标题 · ${meta.sessionId.slice(-8)}`;
	return "未命名会话";
}

/** Time label (relative-ish, compact). */
function timeLabel(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Mount the archive panel into the center column.
 * Fetches the archived list from our host routes and renders rows with a
 * restore button per row.
 */
function mountPanel(controller) {
	let root;
	let container;
	const ensure = () => {
		if (container !== void 0) {
			if (container.isConnected) return;
			root?.unmount();
			root = void 0;
			container.remove();
			container = void 0;
		}
		const column = conversationColumn();
		if (column === void 0) return;
		container = document.createElement("div");
		container.dataset.dshArchiveView = "";
		container.className = "dsham-view";
		column.appendChild(container);
		root = window.__dshReactCreateRoot ? window.__dshReactCreateRoot(container) : null;
		if (root === null) {
			// No React helper available — render plain DOM (still fully functional).
			renderPlain(container, controller);
		} else {
			root.render(renderReact(controller));
		}
	};
	const waitObserver = new MutationObserver(() => {
		ensure();
	});
	waitObserver.observe(document.body, { childList: true, subtree: true });
	const applyActive = () => {
		if (controller.getSnapshot().open) {
			for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr);
			document.documentElement.setAttribute(ACTIVE_ATTR, "");
			document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
		} else {
			document.documentElement.removeAttribute(ACTIVE_ATTR);
		}
	};
	const onOtherActivate = (event) => {
		if (event.detail === "ssh" || event.detail === "taskboard") controller.close();
	};
	const SIDEBAR_ROW_SELECTOR = "[class*=\"sessionRow\"], [class*=\"projectRow\"], [class*=\"searchResultRow\"], [class*=\"searchResultWorkspace\"], [class*=\"newSession\"]";
	const onClickSidebarRow = (event) => {
		if (!controller.getSnapshot().open) return;
		const target = event.target;
		if (target === null) return;
		if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close();
	};
	document.addEventListener("click", onClickSidebarRow, true);
	document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
	const unsubscribe = controller.subscribe(applyActive);
	applyActive();
	ensure();
	return () => {
		document.removeEventListener("click", onClickSidebarRow, true);
		document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
		waitObserver.disconnect();
		unsubscribe();
		document.documentElement.removeAttribute(ACTIVE_ATTR);
		root?.unmount();
		root = void 0;
		container?.remove();
		container = void 0;
	};
}

/** Plain-DOM fallback renderer (no React dependency). */
function renderPlain(container, controller) {
	container.innerHTML = "";
	const title = document.createElement("h3");
	title.className = "dsham-title";
	title.textContent = "历史归档";
	container.appendChild(title);
	const status = document.createElement("p");
	status.className = "dsham-status";
	status.textContent = "加载中…";
	container.appendChild(status);
	const listEl = document.createElement("div");
	listEl.className = "dsham-list";
	container.appendChild(listEl);
	// Refresh whenever the panel opens, and poll while it stays open, so
	// archiving/restoring a session elsewhere shows up here without a reload.
	controller.subscribe((snapshot) => {
		if (snapshot.open) reload();
	});
	const poll = window.setInterval(() => {
		if (!container.isConnected) {
			window.clearInterval(poll);
			return;
		}
		if (controller.getSnapshot().open) reload();
	}, 3000);
	reload();
	function reload() {
	fetch("/api/archive-manager/list")
		.then((r) => r.json())
		.then((data) => {
			const ids = data?.archivedSessionIds ?? [];
			const items = Array.isArray(data?.items) && data.items.length === ids.length
				? data.items
				: ids.map((id) => ({ sessionId: id }));
			status.textContent = `共 ${items.length} 条归档记录`;
			listEl.innerHTML = "";
			if (items.length === 0) {
				const empty = document.createElement("div");
				empty.className = "dsham-empty";
				empty.textContent = "暂无归档会话";
				listEl.appendChild(empty);
				return;
			}
			for (const item of items) {
				const id = item.sessionId;
				if (id === void 0 || id === null) continue;
				const row = document.createElement("div");
				row.className = "dsham-item";
				const label = document.createElement("span");
				label.className = "dsham-itemTitle";
				label.textContent = labelFor(item);
				label.title = id;
				const time = document.createElement("span");
				time.className = "dsham-itemTime";
				time.textContent = timeLabel(item.updatedAt);
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = "dsham-restore";
				btn.textContent = "恢复";
				btn.addEventListener("click", async () => {
					btn.disabled = true;
					btn.textContent = "恢复中…";
					try {
						const resp = await fetch("/api/archive-manager/unarchive", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ sessionId: id })
						});
						const result = await resp.json();
						if (result?.ok) {
							row.remove();
							status.textContent = `共 ${items.length - 1} 条归档记录`;
						} else {
							btn.disabled = false;
							btn.textContent = "恢复";
							status.textContent = `恢复失败: ${result?.error ?? "未知错误"}`;
						}
					} catch (error) {
						btn.disabled = false;
						btn.textContent = "恢复";
						status.textContent = `恢复失败: ${String(error?.message ?? error)}`;
					}
				});
				row.appendChild(label);
				if (time.textContent !== "") row.appendChild(time);
				row.appendChild(btn);
				listEl.appendChild(row);
			}
		})
		.catch((error) => {
			status.textContent = `加载失败: ${String(error?.message ?? error)}`;
		});
	}
}

/** React renderer (used when the host exposes a createRoot helper). */
function renderReact(controller) {
	// Dynamic require of React would fail in a plain ESM browser bundle;
	// the plain-DOM path is the primary renderer. This stub exists so the
	// mount point stays React-compatible if a future host provides one.
	return null;
}

/** Mount the sidebar entry, waiting for the shell and self-healing. */
function mountSidebarEntry(controller) {
	const entry = createEntry(controller);
	let root;
	let placed = false;
	const tryPlace = () => {
		if (root !== void 0 && !root.isConnected) {
			rootObserver.disconnect();
			root = void 0;
			placed = false;
		}
		if (placed) {
			if (document.body.contains(entry)) return;
			rootObserver.disconnect();
			root = void 0;
			placed = false;
		}
		root ??= sidebarRoot();
		if (root === void 0) return;
		placed = placeEntry(root, entry);
		if (placed) rootObserver.observe(root, { childList: true, subtree: true });
	};
	const waitObserver = new MutationObserver(() => {
		tryPlace();
	});
	waitObserver.observe(document.body, { childList: true, subtree: true });
	const rootObserver = new MutationObserver(() => {
		if (root === void 0 || !root.isConnected) {
			placed = false;
			tryPlace();
			return;
		}
		if (!root.contains(entry)) placed = placeEntry(root, entry);
	});
	const syncActive = () => {
		if (controller.getSnapshot().open) entry.dataset.active = "true";
		else delete entry.dataset.active;
	};
	const unsubscribe = controller.subscribe(syncActive);
	syncActive();
	tryPlace();
	return () => {
		waitObserver.disconnect();
		rootObserver.disconnect();
		unsubscribe();
		entry.remove();
	};
}

/** Required services (fiber inject waiting — the runtime must be up first). */
const inject = ["locale", "slots"];

/** Plugin entry: wire everything together. */
function apply(ctx) {
	ctx.effect(() => {
		injectStyles("dsh-archive-manager");
		const controller = createController();
		const disposers = [
			mountSidebarEntry(controller),
			mountPanel(controller)
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "archive-manager: client");
}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
