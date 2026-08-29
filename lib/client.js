//#region lib/client.js
// Agent Discipline Guard - browser half.
//
// Two UI surfaces:
//  1. Settings section (Settings -> Discipline Guard): master switch, each
//     gate's on/off, thresholds, and one-click presets (off / daily / wild).
//  2. A session-header chip showing guard status; clicking it toggles the
//     master switch, so the escape hatch is one click away in the main UI.

window.__ModuleLoader__.load({
	id: "dsh-discipline-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var h = react.createElement;

		var NS = "discipline-guard";

		var css = [
			".dg_chip{height:22px;font-size:12px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}",
			".dg_chip_on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
			".dg_section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;padding:8px 0;display:flex}",
			".dg_title{font-size:16px;font-weight:500;margin:0}",
			".dg_intro{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:18px;margin:0}",
			".dg_block{background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;flex-direction:column;gap:10px;display:flex}",
			".dg_blockTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary);margin:0}",
			".dg_help{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:16px;margin:0}",
			".dg_row{align-items:center;gap:10px;display:flex}",
			".dg_rowLabel{flex:0 0 280px;font-size:13px;color:var(--dsw-alias-label-primary)}",
			".dg_input{width:130px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;padding:0 8px}",
			".dg_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".dg_input_wide{width:380px}",
			".dg_toggle{position:relative;width:36px;height:20px;background:var(--dsw-alias-border-l2);border-radius:10px;cursor:pointer;transition:background .15s;flex:none;border:none;padding:0}",
			".dg_toggle_on{background:var(--dsw-alias-brand-primary)}",
			".dg_toggle_knob{position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:left .15s}",
			".dg_toggle_on .dg_toggle_knob{left:18px}",
			".dg_chipBtn{height:24px;font-size:11px;padding:0 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dg_chipBtn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
			".dg_saveBtn{height:32px;padding:0 18px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary);color:#fff;font-size:13px;cursor:pointer}",
			".dg_saveBtn:disabled{opacity:.5;cursor:default}",
			".dg_notice{font-size:12px;color:var(--dsw-alias-state-warn-fg,#b58a30)}"
		].join("\n");
		var tagId = "dsh-discipline-guard/guard.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-discipline-guard";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		var DEFAULTS = {
			enabled: true,
			loopEnabled: true,
			loopWarnAt: 2,
			loopBlockAt: 4,
			loopFailBlockAt: 2,
			loopExclude: ["job_output", "job_list", "list_agents", "get_goal"],
			costEnabled: true,
			costRequestInputMax: 100000,
			costContextMin: 80000,
			costCacheFloorPct: 50,
			costTurnBudget: 500000,
			costHardStop: true,
			routeEnabled: true,
			routeHistoryMin: 50000,
			planEnabled: false,
			planTools: ["write", "edit", "bash"]
		};

		var PRESETS = {
			off: { enabled: false },
			daily: Object.assign({}, DEFAULTS, { enabled: true }),
			wild: Object.assign({}, DEFAULTS, {
				enabled: true,
				costHardStop: false,
				planEnabled: false,
				loopBlockAt: 20,
				loopFailBlockAt: 10
			})
		};

		async function loadConfig(api) {
			var resp = await api.settings.describe({});
			if (!resp.result.ok) throw new Error(resp.result.error.message);
			var entry = (resp.result.value.namespaces || []).find(function (v) {
				return v.ns === NS;
			});
			return {
				value: Object.assign({}, DEFAULTS, entry && entry.value ? entry.value : {}),
				revision: entry ? entry.revision : 0,
				writable: Boolean(resp.result.value.writable)
			};
		}

		async function saveConfig(api, values, revision) {
			var ops = Object.keys(DEFAULTS).map(function (k) {
				return { op: "set", path: [k], value: values[k] };
			});
			var resp = await api.settings.mutate({ ns: NS, ops: ops, expectedRevision: revision });
			if (!resp.result.ok) throw new Error(resp.result.error.message);
		}

		function Toggle(props) {
			return h(
				"button",
				{
					type: "button",
					className: props.value ? "dg_toggle dg_toggle_on" : "dg_toggle",
					onClick: function () {
						props.onChange(!props.value);
					},
					"aria-checked": props.value,
					role: "switch"
				},
				h("span", { className: "dg_toggle_knob" })
			);
		}

		function Row(props) {
			var control;
			if (props.kind === "switch") {
				control = h(Toggle, { value: props.value, onChange: props.onChange });
			} else if (props.kind === "text") {
				control = h("input", {
					className: "dg_input dg_input_wide",
					type: "text",
					value: props.value.join(", "),
					onChange: function (e) {
						props.onChange(
							e.target.value
								.split(",")
								.map(function (s) {
									return s.trim();
								})
								.filter(Boolean)
						);
					}
				});
			} else {
				control = h("input", {
					className: "dg_input",
					type: "number",
					min: props.min,
					max: props.max,
					step: props.step,
					value: props.value,
					onChange: function (e) {
						props.onChange(Number(e.target.value));
					}
				});
			}
			return h(
				"div",
				{ className: "dg_row" },
				h("span", { className: "dg_rowLabel" }, props.label),
				control
			);
		}

		function Block(props) {
			return h(
				"div",
				{ className: "dg_block" },
				h("h4", { className: "dg_blockTitle" }, props.title),
				props.help ? h("p", { className: "dg_help" }, props.help) : null,
				props.children
			);
		}

		function GuardChip(props) {
			var pair = react.useState(null);
			var enabled = pair[0];
			var setEnabled = pair[1];
			var connection = props.connection;
			react.useEffect(function () {
				if (!connection || !connection.api) return;
				var alive = true;
				loadConfig(connection.api)
					.then(function (snap) {
						if (alive) setEnabled(snap.value.enabled);
					})
					.catch(function () {
						if (alive) setEnabled(false);
					});
				return function () {
					alive = false;
				};
			}, [connection]);
			if (enabled === null) return null;
			return h(
				"button",
				{
					type: "button",
					className: enabled ? "dg_chip dg_chip_on" : "dg_chip",
					title: enabled ? "纪律卫士已启用 — 点击停用" : "纪律卫士已停用 — 点击启用",
					onClick: async function () {
						if (!connection || !connection.api) return;
						try {
							var snap = await loadConfig(connection.api);
							var next = !snap.value.enabled;
							await saveConfig(connection.api, Object.assign({}, snap.value, { enabled: next }), snap.revision);
							setEnabled(next);
						} catch (error) {
							/* ignore */
						}
					}
				},
				enabled ? "🛡 纪律卫士" : "⚪ 纪律卫士"
			);
		}

		function GuardSettingsSection(props) {
			var pair = react.useState({
				status: "loading",
				value: DEFAULTS,
				revision: 0,
				writable: true,
				dirty: false,
				saved: false,
				saving: false,
				error: null
			});
			var s = pair[0];
			var setS = pair[1];
			var api = props.connection && props.connection.api;

			function set(patch) {
				setS(function (prev) {
					return Object.assign({}, prev, {
						value: Object.assign({}, prev.value, patch),
						dirty: true,
						saved: false
					});
				});
			}

			var loaded = react.useRef(false);
			react.useEffect(function () {
				if (loaded.current || !api) return;
				loaded.current = true;
				var alive = true;
				loadConfig(api)
					.then(function (snap) {
						if (!alive) return;
						setS({
							status: "ready",
							value: snap.value,
							revision: snap.revision,
							writable: snap.writable,
							dirty: false,
							saved: false,
							saving: false,
							error: null
						});
					})
					.catch(function (error) {
						if (alive) setS(function (prev) {
							return Object.assign({}, prev, { status: "error", error: String((error && error.message) || error) });
						});
					});
				return function () {
					alive = false;
				};
			}, [api]);

			async function handleSave() {
				setS(function (prev) {
					return Object.assign({}, prev, { saving: true });
				});
				try {
					var snap = await loadConfig(api);
					await saveConfig(api, s.value, snap.revision);
					setS(function (prev) {
						return Object.assign({}, prev, { saving: false, dirty: false, saved: true, revision: snap.revision, error: null });
					});
				} catch (error) {
					setS(function (prev) {
						return Object.assign({}, prev, { saving: false, error: String((error && error.message) || error) });
					});
				}
			}

			function applyPreset(patch) {
				setS(function (prev) {
					return Object.assign({}, prev, {
						value: Object.assign({}, prev.value, patch),
						dirty: true,
						saved: false
					});
				});
			}

			if (s.status === "loading") {
				return h("div", { className: "dg_section" }, h("p", { className: "dg_intro" }, "加载纪律卫士设置…"));
			}
			var v = s.value;
			return h(
				"div",
				{ className: "dg_section" },
				h("h3", { className: "dg_title" }, "Agent 纪律卫士"),
				h(
					"p",
					{ className: "dg_intro" },
					"四道硬闸门：循环熔断、成本熔断、路由警示、计划门。闸门在 harness 边界执行，模型无法无视；烧钱类闸门默认 fail-closed。"
				),
				h(
					Block,
					{ title: "总开关 / 预设" },
					h(Row, { label: "启用纪律卫士", kind: "switch", value: v.enabled, onChange: function (x) { set({ enabled: x }); } }),
					h(
						"div",
						{ className: "dg_row" },
						h("button", { className: "dg_chipBtn", onClick: function () { applyPreset(PRESETS.off); } }, "off · 全关"),
						h("button", { className: "dg_chipBtn", onClick: function () { applyPreset(PRESETS.daily); } }, "daily · 日常推荐"),
						h("button", { className: "dg_chipBtn", onClick: function () { applyPreset(PRESETS.wild); } }, "wild · 开发实验")
					)
				),
				h(
					Block,
					{
						title: "① 循环门（Loop）",
						help: "同名 + 同参数的工具调用连续计数（不论成败）。达到预警值注入提醒；达到熔断值或连续失败达到上限则直接拒绝该调用，直到用户发新消息解除。"
					},
					h(Row, { label: "启用", kind: "switch", value: v.loopEnabled, onChange: function (x) { set({ loopEnabled: x }); } }),
					h(Row, { label: "预警阈值（连续相同次数）", kind: "number", min: 2, max: 100, value: v.loopWarnAt, onChange: function (x) { set({ loopWarnAt: x }); } }),
					h(Row, { label: "熔断阈值（连续相同次数）", kind: "number", min: 2, max: 200, value: v.loopBlockAt, onChange: function (x) { set({ loopBlockAt: x }); } }),
					h(Row, { label: "连续失败熔断（次）", kind: "number", min: 1, max: 100, value: v.loopFailBlockAt, onChange: function (x) { set({ loopFailBlockAt: x }); } }),
					h(Row, { label: "豁免工具（逗号分隔，支持 *）", kind: "text", value: v.loopExclude, onChange: function (x) { set({ loopExclude: x }); } })
				),
				h(
					Block,
					{
						title: "② 成本门（Cost）",
						help: "按每步真实 usage 计量：单步净计费输入超阈值且缓存命中率低于下限（token-plan 全价重发模式），或回合累计超预算 — 先注入预警要求汇报，同回合再犯则硬停回合；回复「继续」放行一次。"
					},
					h(Row, { label: "启用", kind: "switch", value: v.costEnabled, onChange: function (x) { set({ costEnabled: x }); } }),
					h(Row, { label: "单步净计费输入阈值（token）", kind: "number", min: 1000, max: 5000000, step: 1000, value: v.costRequestInputMax, onChange: function (x) { set({ costRequestInputMax: x }); } }),
					h(Row, { label: "最小生效上下文（token）", kind: "number", min: 1000, max: 5000000, step: 1000, value: v.costContextMin, onChange: function (x) { set({ costContextMin: x }); } }),
					h(Row, { label: "缓存命中率下限（%）", kind: "number", min: 0, max: 100, value: v.costCacheFloorPct, onChange: function (x) { set({ costCacheFloorPct: x }); } }),
					h(Row, { label: "每回合计费预算（token）", kind: "number", min: 10000, max: 20000000, step: 10000, value: v.costTurnBudget, onChange: function (x) { set({ costTurnBudget: x }); } }),
					h(Row, { label: "同回合再犯硬停（fail-closed）", kind: "switch", value: v.costHardStop, onChange: function (x) { set({ costHardStop: x }); } })
				),
				h(
					Block,
					{ title: "③ 路由门（Route）", help: "会话中切换模型端点且历史较长时，向下一步注入一次性全价成本警示。" },
					h(Row, { label: "启用", kind: "switch", value: v.routeEnabled, onChange: function (x) { set({ routeEnabled: x }); } }),
					h(Row, { label: "触发历史阈值（token）", kind: "number", min: 1000, max: 5000000, step: 1000, value: v.routeHistoryMin, onChange: function (x) { set({ routeHistoryMin: x }); } })
				),
				h(
					Block,
					{ title: "④ 计划门（Plan，默认关）", help: "开启后，每个用户回合的首个写/执行类工具调用会弹出原生审批卡；批准一次放行本回合同类操作。" },
					h(Row, { label: "启用", kind: "switch", value: v.planEnabled, onChange: function (x) { set({ planEnabled: x }); } }),
					h(Row, { label: "受控工具（逗号分隔）", kind: "text", value: v.planTools, onChange: function (x) { set({ planTools: x }); } })
				),
				h(
					"div",
					{ className: "dg_row", style: { gap: 12 } },
					h(
						"button",
						{ className: "dg_saveBtn", disabled: !s.dirty || s.saving || !s.writable, onClick: handleSave },
						s.saving ? "保存中…" : "保存设置"
					),
					s.saved ? h("span", { className: "dg_notice" }, "✓ 已保存") : null,
					s.error ? h("span", { className: "dg_notice" }, String(s.error)) : null
				)
			);
		}

		var inject = ["slots", "connection"];

		function apply(ctx) {
			var slots = ctx.get("slots");
			if (slots === void 0) return;
			var connection = ctx.get("connection");

			slots.inject("conversation.session.header.actions", function () {
				return slots.register(
					{
						name: "conversation.session.header.actions",
						id: "discipline-guard",
						order: -7
					},
					function (renderProps) {
						return h(GuardChip, Object.assign({}, renderProps, { connection: connection }));
					}
				);
			});

			slots.inject("settings.section", function () {
				return slots.register(
					{
						name: "settings.section",
						id: "discipline-guard",
						order: 100,
						label: "纪律卫士"
					},
					function (renderProps) {
						return h(GuardSettingsSection, Object.assign({}, renderProps, { connection: connection }));
					}
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
//#endregion
