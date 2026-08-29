//#region lib/index.js
/**
 * Agent Discipline Guard (纪律卫士) — host half.
 *
 * Four hard gates, enforced at the harness boundary so the model cannot
 * textually ignore them; every gate is individually switchable with its own
 * thresholds through the `discipline-guard` settings namespace, and the user
 * can always release a pause by replying in the conversation:
 *
 *  ① 循环门 (Loop gate)     — counts identical tool+arguments calls per agent
 *      (successes AND failures). warnAt → visible notice; blockAt /
 *      failBlockAt consecutive failures → `tools/pre-execute` deny, which
 *      keeps denying until a genuine user message arrives.
 *  ② 成本门 (Cost gate)     — meters every step from real `assistant/message`
 *      usage. A step that paid ≥ requestInputMax net input tokens with cache
 *      hits below cacheFloorPct (the token-plan burn pattern), or a turn that
 *      exceeded its budget → first a visible warning notice; a repeat
 *      violation inside the same turn → `agent/pre-step` reject (turn hard
 *      stop). Fail-closed: a stopped turn stays stopped; typing 继续/放行
 *      releases the gate for that one turn.
 *  ③ 路由门 (Route gate)    — on `request/header` reason=change with a long
 *      history, injects a one-time full-price cost warning into the next step.
 *  ④ 计划门 (Plan gate)     — opt-in: routes the first mutating tool call of
 *      each user turn through the native approval card (`approval.request`).
 *
 * Every listener is fail-open internally: a guard bug must never brick the
 * harness it is protecting.
 */
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/** Plugin row id / settings namespace owner. */
const name = "discipline-guard";
const NS = settingsNamespace("discipline-guard");

/** Settings schema. Flat keys keep the settings UI and patch config simple. */
const Config = z.object({
  enabled: z.boolean().default(true),
  // ① 循环门
  loopEnabled: z.boolean().default(true),
  loopWarnAt: z.number().step(1).min(2).max(100).default(2),
  loopBlockAt: z.number().step(1).min(2).max(200).default(4),
  loopFailBlockAt: z.number().step(1).min(1).max(100).default(2),
  loopExclude: z.array(z.string()).default(["job_output", "job_list", "list_agents", "get_goal"]),
  // ② 成本门
  costEnabled: z.boolean().default(true),
  costRequestInputMax: z.number().step(1).min(1000).default(100000),
  costContextMin: z.number().step(1).min(1000).default(80000),
  costCacheFloorPct: z.number().step(1).min(0).max(100).default(50),
  costTurnBudget: z.number().step(1).min(10000).default(500000),
  costHardStop: z.boolean().default(true),
  // ② 成本门 · 当前路由缓存判定：auto（按命中率推测）| cached（有缓存）| nocache（无缓存套餐）
  routeCacheMode: z.enum(["auto", "cached", "nocache"]).default("auto"),
  // ③ 路由门
  routeEnabled: z.boolean().default(true),
  routeHistoryMin: z.number().step(1).min(1000).default(50000),
  // ④ 计划门（默认关）
  planEnabled: z.boolean().default(false),
  planTools: z.array(z.string()).default(["write", "edit", "bash"]),
});

/** Concrete default entry used as the settings composition base. */
const DEFAULT_ENTRY = {
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
  routeCacheMode: "auto",
  routeEnabled: true,
  routeHistoryMin: 50000,
  planEnabled: false,
  planTools: ["write", "edit", "bash"],
};

/** Release keywords that un-pause the cost gate for one turn. */
const RELEASE_RE = /(继续|放行|别停|照常)/;

/** Compact token formatter for notice texts. */
function fmtTokens(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

/** Deep key-sort so two argument objects differing only in property order canonicalize identically. */
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value;
    const sorted = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
    return sorted;
  }
  return value;
}

/** Canonical string form of a call's arguments. */
function canonicalize(argumentsValue) {
  if (argumentsValue === void 0 || argumentsValue === null) return "";
  return JSON.stringify(sortJsonValue(argumentsValue));
}

/** Compile one `*`-wildcard pattern to an anchored RegExp. */
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

/** Build one plugin-notice message (renders like the repeat-tool reminder). */
function notice(text, summary) {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name, form: "notice", summary },
  };
}

/** Text of a user message part list, for the release-keyword check. */
function userText(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join(" ");
  return "";
}

/** Plugin body. */
function apply(ctx) {
  let current = () => DEFAULT_ENTRY;

  /** Per-agent mutable gate state. */
  const agentStates = new WeakMap();
  function agentState(agent) {
    let state = agentStates.get(agent);
    if (state === void 0) {
      state = { turn: 0, chain: void 0, blockedKey: void 0, planConfirmedTurn: -1 };
      agentStates.set(agent, state);
    }
    return state;
  }

  /** Per-session usage meter, keyed by session id (scalars only). */
  const meters = new Map();
  function meterFor(session) {
    let m = meters.get(session.id);
    if (m === void 0) {
      m = { turn: -1, billed: 0, lastInput: 0, lastCacheRead: 0, warnTurn: 0, routePending: null, routeNotified: null, userRelease: false };
      meters.set(session.id, m);
    }
    return m;
  }

  /** Whether a tool name is exempted from the loop gate. */
  function excluded(toolName, cfg) {
    return cfg.loopExclude.some((pattern) => wildcardToRegExp(pattern).test(toolName));
  }

  // ---- usage & route observers -------------------------------------------
  ctx.on("session/event", (session, event) => {
    try {
      if (!session || !event || typeof event.type !== "string") return;
      if (event.type === "assistant/message") {
        const usage = event.data && event.data.usage;
        if (!usage) return;
        const m = meterFor(session);
        const turn = event.data.turn;
        if (m.turn !== turn) {
          m.turn = turn;
          m.billed = 0;
        }
        m.lastInput = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
        m.lastCacheRead = typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0;
        m.billed += m.lastInput;
      } else if (event.type === "request/header") {
        const data = event.data;
        if (!data || data.reason !== "change" || !data.header || !data.header.config) return;
        const config = data.header.config;
        meterFor(session).routePending = `${config.provider || "?"}/${config.model || "?"}`;
      }
    } catch (error) {
      /* metering must never break the session */
    }
  });
  ctx.on("session/disposed", (session) => {
    try {
      if (session && session.id !== void 0) meters.delete(session.id);
    } catch (error) {
      /* ignore */
    }
  });

  // ---- ① loop gate: deny repeated identical calls after the block tier ---
  ctx.on("tools/pre-execute", async (exec, next) => {
    const cfg = current();
    try {
      if (!cfg.enabled || !cfg.loopEnabled || !exec.agent) return await next();
      const state = agentState(exec.agent);
      if (!excluded(exec.name, cfg)) {
        const key = JSON.stringify([exec.name, canonicalize(exec.arguments)]);
        if (state.blockedKey === key) {
          const count = state.chain && state.chain.key === key ? state.chain.count : cfg.loopBlockAt;
          return {
            kind: "deny",
            reason: `【纪律卫士·循环门】同一工具调用（${exec.name}，相同参数）已连续 ${count} 次，触发熔断：本次调用被拒绝。不要再重复该调用；请汇报当前进展并等待用户指示。（用户回复任何新消息即解除熔断）`,
          };
        }
      }
      if (cfg.planEnabled && cfg.planTools.includes(exec.name)) {
        const approval = ctx.get("approval");
        if (approval && state.planConfirmedTurn !== state.turn) {
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: exec.name,
            callId: exec.callId,
            reason: `【纪律卫士·计划门】本回合首个写/执行类操作：${exec.name}。批准 = 允许本回合内写/执行类操作继续执行。`,
            signal: exec.signal,
          });
          if (outcome === "allowed-once") {
            state.planConfirmedTurn = state.turn;
            return await next();
          }
          return { kind: "deny", reason: `【纪律卫士·计划门】用户未批准执行 ${exec.name}。请先向用户说明你的计划并等待指示。` };
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`discipline-guard: pre-execute listener failed (fail-open): ${error && error.message}`);
    }
    return await next();
  });

  // ---- ① loop gate: count attempts + inject escalation reminders ---------
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const cfg = current();
    let reminder;
    try {
      if (cfg.enabled && cfg.loopEnabled && exec.agent && !excluded(exec.name, cfg)) {
        const state = agentState(exec.agent);
        const key = JSON.stringify([exec.name, canonicalize(exec.arguments)]);
        const prev = state.chain && state.chain.key === key ? state.chain : void 0;
        const count = prev ? prev.count + 1 : 1;
        const failed = result && (result.isError === true || result.error != null);
        const fails = failed ? (prev ? prev.fails : 0) + 1 : 0;
        state.chain = { key, count, fails };
        if (count >= cfg.loopBlockAt || fails >= cfg.loopFailBlockAt) {
          state.blockedKey = key;
          ctx.logger?.warn?.(`discipline-guard: loop gate tripped for ${exec.name} (count=${count}, fails=${fails})`);
        }
        if (count === cfg.loopWarnAt) {
          reminder = notice(
            `【纪律卫士·循环门·预警】检测到你第 ${count} 次以完全相同参数调用 ${exec.name}。再重复至 ${cfg.loopBlockAt} 次（或连续失败 ${cfg.loopFailBlockAt} 次）将熔断该调用并要求你停下汇报。请基于上一次结果换思路，或结束该子任务。`,
            `${exec.name} × ${count}`,
          );
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`discipline-guard: post-execute listener failed (fail-open): ${error && error.message}`);
    }
    const downstream = await next();
    if (!reminder) return downstream;
    if (downstream.kind === "block") return { ...downstream, additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])] };
    return { ...downstream, additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])] };
  });

  // ---- ② cost gate + ③ route gate + loop-chain release --------------------
  ctx.on("agent/pre-step", async ({ agent, messages, turn, step, signal }, next) => {
    const cfg = current();
    try {
      const state = agentState(agent);
      state.turn = turn;
      const session = agent && agent.session;
      const meter = session ? meters.get(session.id) : void 0;
      const freshUser = (messages ?? []).find((msg) => msg && msg.source && msg.source.kind === "user");
      if (meter && freshUser) {
        state.chain = void 0;
        state.blockedKey = void 0;
        meter.warnTurn = 0;
        meter.userRelease = RELEASE_RE.test(userText(freshUser));
      }
    } catch (error) {
      ctx.logger?.warn?.(`discipline-guard: pre-step release reset failed: ${error && error.message}`);
    }
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    try {
      if (!cfg.enabled || !agent || !agent.session) return decision;
      const meter = meters.get(agent.session.id);
      if (!meter) return decision;
      const added = [];
      // ③ 路由门：一次性切换警示
      if (cfg.routeEnabled && meter.routePending) {
        const route = meter.routePending;
        meter.routePending = null;
        const history = meter.lastInput + meter.lastCacheRead;
        if (history >= cfg.routeHistoryMin && meter.routeNotified !== route) {
          meter.routeNotified = route;
          added.push(
            notice(
              `【纪律卫士·路由门】检测到本会话模型路由切换 → ${route}。当前对话上下文约 ${fmtTokens(history)} token；若新端点无提示缓存，本回合每步将按全价重发该上下文。如果这是新话题，建议另开干净会话；确认继续则回复「继续」。`,
              `路由切换 · ${route}`,
            ),
          );
        }
      }
      // ② 成本门
      if (cfg.costEnabled && !meter.userRelease) {
        const context = meter.lastInput + meter.lastCacheRead;
        const cachePct = context > 0 ? (100 * meter.lastCacheRead) / context : 100;
        // 路由缓存判定：auto（按命中率推测）| cached（已知有缓存，不因低命中率误报）| nocache（已知套餐全价重发，从严）
        let resendViolation;
        if (cfg.routeCacheMode === "cached") {
          resendViolation = false;
        } else if (cfg.routeCacheMode === "nocache") {
          resendViolation = meter.lastInput >= cfg.costRequestInputMax && context >= cfg.costContextMin;
        } else {
          resendViolation =
            meter.lastInput >= cfg.costRequestInputMax && context >= cfg.costContextMin && cachePct < cfg.costCacheFloorPct;
        }
        const violation = resendViolation || meter.billed >= cfg.costTurnBudget;
        if (violation) {
          const modeTag =
            cfg.routeCacheMode === "cached" ? "，已知有缓存路由" : cfg.routeCacheMode === "nocache" ? "，已知无缓存套餐路由" : "";
          const detail = `上一步净计费输入 ${fmtTokens(meter.lastInput)}（缓存命中率 ${cachePct.toFixed(1)}%）${modeTag}，本回合已累计 ${fmtTokens(meter.billed)} / 预算 ${fmtTokens(cfg.costTurnBudget)}`;
          if (cfg.costHardStop && meter.warnTurn === turn) {
            ctx.logger?.warn?.(`discipline-guard: cost gate REJECT turn ${turn} step ${step} — ${detail}`);
            return { kind: "reject" };
          }
          if (meter.warnTurn !== turn) {
            meter.warnTurn = turn;
            added.push(
              notice(
                `【纪律卫士·成本门·预警】${detail}。这是无缓存全价重发的典型模式——放任跑下去，一个回合能烧掉数百万 token。请立即停止新的工具调用：向用户简要汇报当前进展与剩余步骤，等待用户回复。用户回复「继续」即可放行。`,
                "成本预警",
              ),
            );
          }
        }
      }
      if (added.length === 0) return decision;
      return { ...decision, messages: [...decision.messages, ...added] };
    } catch (error) {
      ctx.logger?.warn?.(`discipline-guard: pre-step gate check failed (fail-open): ${error && error.message}`);
      return decision;
    }
  });

  // ---- settings -----------------------------------------------------------
  installSettingsSection(ctx, NS, Config, DEFAULT_ENTRY, {
    validate(value) {
      if (value.loopBlockAt < value.loopWarnAt) throw new Error("discipline-guard: loopBlockAt 不能小于 loopWarnAt");
    },
    setSource(source) {
      current = source;
    },
    onChange() {
      /* gates read current() live; nothing to re-register */
    },
  });

  ctx.effect(() => () => {
    meters.clear();
  }, "discipline-guard: clear-meters-on-stop");
}

export { Config, apply, name };
//#endregion
