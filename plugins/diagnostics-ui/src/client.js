window.__ModuleLoader__.load({
  id: "@dsh-workbench/diagnostics-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const NS = "dshWorkbench.diagnostics";
    const EXPECTED_DSH_VERSION = "0.1.1-rc.2";
    const TAIL_PAGE_LIMIT = 200;
    const MAX_TAIL_PAGES = 4;
    const REQUIRED_ENTRIES = Object.freeze([
      Object.freeze({ entryId: "dsh-workbench-authorization", moduleName: "@deepseek-ai/dsh-authorization" }),
      Object.freeze({ entryId: "dsh-workbench-desktop-core", moduleName: "@dsh-workbench/desktop-core" }),
      Object.freeze({ entryId: "dsh-workbench-oauth-ui", moduleName: "@dsh-workbench/oauth-ui" }),
      Object.freeze({ entryId: "dsh-workbench-diagnostics-ui", moduleName: "@dsh-workbench/diagnostics-ui" }),
    ]);
    const inject = ["slots", "locale", "remote", "remote.pluginInventory"];

    const dictionaries = {
      zh: {
        tab: "Workbench 诊断",
        title: "Workbench 诊断",
        description: "插件状态来自 DSH 官方清单；运行日志由桌面宿主在当前档案和运行代际内保存。",
        loading: "正在读取诊断信息…",
        unavailable: "诊断信息暂不可用。",
        retry: "刷新",
        healthy: "状态正常",
        transitioning: "正在切换",
        attention: "需要处理",
        versions: "版本",
        runtime: "运行状态",
        profile: "当前档案",
        plugins: "Workbench 插件",
        logs: "最近运行日志",
        noLogs: "当前运行代际还没有日志。",
        clearLogs: "清空日志",
        restart: "重启当前 DSH",
        repair: "修复 Workbench 插件并重启",
        repairHint: "修复只会重建 Workbench 自有 overlay 和包链接，不会修改第三方插件或档案数据。",
        restarting: "正在等待桌面确认…",
        active: "已挂载",
        missing: "缺失",
        disabled: "已停用",
        failed: "挂载失败",
        unmounted: "未挂载",
        transitioningState: "过渡中",
        moduleMismatch: "模块不匹配",
        duplicate: "重复条目",
        versionMismatch: "DSH 版本不匹配",
        unassessed: "其他插件由官方 Plugin list 展示，Workbench 不评估其兼容性。",
      },
      en: {
        tab: "Workbench diagnostics",
        title: "Workbench diagnostics",
        description: "Plugin state comes from the official DSH inventory. The desktop host keeps runtime logs inside the current profile generation.",
        loading: "Reading diagnostics…",
        unavailable: "Diagnostics are temporarily unavailable.",
        retry: "Refresh",
        healthy: "Healthy",
        transitioning: "Transitioning",
        attention: "Needs attention",
        versions: "Versions",
        runtime: "Runtime state",
        profile: "Active profile",
        plugins: "Workbench plugins",
        logs: "Recent runtime log",
        noLogs: "This runtime generation has no log entries yet.",
        clearLogs: "Clear log",
        restart: "Restart current DSH",
        repair: "Repair Workbench plugins and restart",
        repairHint: "Repair recreates only Workbench-owned overlay and package links. It does not modify third-party plugins or profile data.",
        restarting: "Waiting for desktop confirmation…",
        active: "Mounted",
        missing: "Missing",
        disabled: "Disabled",
        failed: "Mount failed",
        unmounted: "Not mounted",
        transitioningState: "Transitioning",
        moduleMismatch: "Module mismatch",
        duplicate: "Duplicate entry",
        versionMismatch: "DSH version mismatch",
        unassessed: "Other plugins remain visible in the official Plugin list and are not compatibility-assessed by Workbench.",
      },
    };

    const styles = {
      root: { color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column", gap: "18px", maxWidth: "820px" },
      heading: { display: "flex", flexDirection: "column", gap: "6px" },
      title: { fontSize: "20px", lineHeight: "28px", margin: 0 },
      description: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: "20px", margin: 0 },
      summary: { alignItems: "center", display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "space-between" },
      badge: { background: "var(--dsw-alias-bg-layer-1)", borderRadius: "999px", fontSize: "12px", padding: "4px 9px" },
      actions: { display: "flex", flexWrap: "wrap", gap: "8px" },
      button: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", color: "var(--dsw-alias-label-primary)", cursor: "pointer", font: "inherit", padding: "7px 11px" },
      primaryButton: { background: "var(--dsw-alias-state-business-primary)", border: "1px solid transparent", borderRadius: "8px", color: "white", cursor: "pointer", font: "inherit", padding: "7px 12px" },
      grid: { display: "grid", gap: "10px", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" },
      card: { background: "var(--dsw-alias-bg-layer-3)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", display: "flex", flexDirection: "column", gap: "5px", padding: "12px 14px" },
      label: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", textTransform: "uppercase" },
      value: { fontSize: "14px", overflowWrap: "anywhere" },
      list: { display: "flex", flexDirection: "column", gap: "8px", listStyle: "none", margin: 0, padding: 0 },
      row: { alignItems: "center", background: "var(--dsw-alias-bg-layer-3)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", display: "flex", gap: "12px", justifyContent: "space-between", padding: "10px 12px" },
      code: { color: "var(--dsw-alias-label-tertiary)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px" },
      log: { background: "var(--dsw-alias-bg-layer-3)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", display: "flex", flexDirection: "column", gap: "6px", maxHeight: "300px", overflow: "auto", padding: "12px" },
      logLine: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", lineHeight: "17px", margin: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
      sectionTitle: { fontSize: "14px", margin: 0 },
      error: { color: "var(--dsw-alias-state-error-primary)", fontSize: "13px", margin: 0 },
      status: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", margin: 0 },
    };

    function hasExpectedEntryId(entry, expectedEntryId) {
      if (typeof entry?.entryId !== "string") return false;
      const segments = entry.entryId.split(":");
      return segments[segments.length - 1] === expectedEntryId;
    }

    function assessWorkbenchCompatibility(snapshot, inventory) {
      const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
      const checks = [];
      const issues = [];
      let hasTransition = false;
      if (snapshot?.dshVersion !== EXPECTED_DSH_VERSION) {
        issues.push({ code: "DSH_VERSION_MISMATCH", expected: EXPECTED_DSH_VERSION });
      }
      for (const expected of REQUIRED_ENTRIES) {
        const matches = entries.filter((entry) => hasExpectedEntryId(entry, expected.entryId));
        let status = "active";
        if (matches.length === 0) {
          status = "missing";
          issues.push({ code: "REQUIRED_ENTRY_MISSING", entryId: expected.entryId });
        } else if (matches.length > 1) {
          status = "duplicate";
          issues.push({ code: "DUPLICATE_ENTRY", entryId: expected.entryId });
        } else {
          const entry = matches[0];
          if (entry.moduleName !== expected.moduleName) {
            status = "module-mismatch";
            issues.push({ code: "MODULE_SPECIFIER_MISMATCH", entryId: expected.entryId });
          } else if (entry.enabled !== true) {
            status = "disabled";
            issues.push({ code: "REQUIRED_ENTRY_DISABLED", entryId: expected.entryId });
          } else if (["pending", "loading", "unloading"].includes(entry.fiberPhase)) {
            status = "transitioning";
            hasTransition = true;
          } else if (entry.fiberPhase === "failed") {
            status = "failed";
            issues.push({ code: "REQUIRED_ENTRY_NOT_ACTIVE", entryId: expected.entryId });
          } else if (entry.fiberPhase !== "active") {
            status = "unmounted";
            issues.push({ code: "REQUIRED_ENTRY_NOT_ACTIVE", entryId: expected.entryId });
          }
        }
        checks.push(Object.freeze({ ...expected, status }));
      }
      return Object.freeze({
        checks: Object.freeze(checks),
        issues: Object.freeze(issues),
        status: issues.length > 0 ? "attention" : hasTransition ? "transitioning" : "healthy",
        unassessedCount: entries.filter((entry) => !REQUIRED_ENTRIES.some((expected) => (
          hasExpectedEntryId(entry, expected.entryId)
        ))).length,
      });
    }

    function bridge() {
      const api = globalThis.dshWorkbench?.runtimeDiagnostics;
      if (!api || !["readTail", "repair", "snapshot"].every((name) => typeof api[name] === "function")) {
        throw new Error("Workbench runtime diagnostics bridge is unavailable");
      }
      return api;
    }

    async function readRecentTail(runtime) {
      const entries = [];
      let afterCursor = 0;
      let tail;
      for (let page = 0; page < MAX_TAIL_PAGES; page += 1) {
        tail = await runtime.readTail(afterCursor, TAIL_PAGE_LIMIT);
        if (!Array.isArray(tail?.entries) || !Number.isSafeInteger(tail?.nextCursor)) {
          throw new Error("Workbench runtime diagnostic tail is invalid");
        }
        entries.push(...tail.entries);
        if (tail.entries.length < TAIL_PAGE_LIMIT) {
          return Object.freeze({ ...tail, entries: Object.freeze(entries.slice(-TAIL_PAGE_LIMIT)) });
        }
        if (tail.nextCursor <= afterCursor) {
          throw new Error("Workbench runtime diagnostic cursor did not advance");
        }
        afterCursor = tail.nextCursor;
      }
      throw new Error("Workbench runtime diagnostic tail did not settle");
    }

    function createApi(ctx) {
      const runtime = bridge();
      return Object.freeze({
        async load() {
          const [snapshot, tail, inventoryResult] = await Promise.all([
            runtime.snapshot(),
            readRecentTail(runtime),
            ctx.remote.pluginInventory.list(),
          ]);
          if (!inventoryResult?.ok) throw new Error("Official plugin inventory is unavailable");
          return Object.freeze({
            compatibility: assessWorkbenchCompatibility(snapshot, inventoryResult.value),
            inventory: inventoryResult.value,
            snapshot,
            tail,
          });
        },
        repair: (action) => runtime.repair(action, crypto.randomUUID()),
      });
    }

    function DiagnosticsTab({ api, t }) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const mounted = React.useRef(false);
      const requestEpoch = React.useRef(0);

      const refresh = React.useCallback(async () => {
        const epoch = ++requestEpoch.current;
        setError("");
        try {
          const next = await api.load();
          if (requestEpoch.current === epoch) setData(next);
        } catch {
          if (requestEpoch.current === epoch) setError(t("unavailable"));
        }
      }, [api, t]);

      React.useEffect(() => {
        mounted.current = true;
        void refresh();
        return () => {
          mounted.current = false;
          requestEpoch.current += 1;
        };
      }, [refresh]);

      const repair = async (action) => {
        if (busy) return;
        setBusy(action);
        setError("");
        try {
          const result = await api.repair(action);
          if (result?.accepted && action === "clear-runtime-logs") await refresh();
          if (mounted.current && (!result?.accepted || action === "clear-runtime-logs")) {
            setBusy("");
          }
        } catch {
          if (mounted.current) {
            setBusy("");
            setError(t("unavailable"));
          }
        }
      };

      const statusLabel = (status) => t(status === "module-mismatch"
        ? "moduleMismatch"
        : status === "transitioning"
          ? "transitioningState"
          : status);
      const compatibility = data?.compatibility;
      const needsRepair = compatibility?.issues.some((issue) => issue.code !== "DSH_VERSION_MISMATCH");
      const button = (label, action, primary, actionId) => h("button", {
        "data-diagnostics-action": actionId,
        disabled: Boolean(busy),
        onClick: action,
        style: { ...(primary ? styles.primaryButton : styles.button), opacity: busy ? 0.55 : 1 },
        type: "button",
      }, label);

      return h("section", {
        "data-diagnostics-health": compatibility?.status || "loading",
        "data-workbench-diagnostics": true,
        style: styles.root,
      },
      h("header", { style: styles.heading },
        h("h2", { style: styles.title }, t("title")),
        h("p", { style: styles.description }, t("description")),
      ),
      h("div", { style: styles.summary },
        h("span", { style: styles.badge }, compatibility ? t(compatibility.status) : t("loading")),
        h("div", { style: styles.actions },
          button(t("retry"), () => void refresh(), false, "refresh"),
          button(t("clearLogs"), () => void repair("clear-runtime-logs"), false, "clear-runtime-logs"),
          button(t("restart"), () => void repair("restart-active-runtime"), true, "restart-active-runtime"),
        ),
      ),
      error ? h("p", { role: "alert", style: styles.error }, error) : null,
      busy && busy !== "clear-runtime-logs" ? h("p", { style: styles.status }, t("restarting")) : null,
      !data && !error ? h("p", { style: styles.status }, t("loading")) : null,
      data ? h(React.Fragment, null,
        h("div", { style: styles.grid },
          h("div", { style: styles.card }, h("span", { style: styles.label }, t("versions")), h("span", { style: styles.value }, `DSH ${data.snapshot.dshVersion} · Workbench ${data.snapshot.appVersion}`)),
          h("div", { style: styles.card }, h("span", { style: styles.label }, t("runtime")), h("span", { style: styles.value }, `${data.snapshot.runtimeState} · generation ${data.snapshot.generation}`)),
          h("div", { style: styles.card }, h("span", { style: styles.label }, t("profile")), h("span", { style: styles.value }, data.snapshot.profileName)),
        ),
        h("h3", { style: styles.sectionTitle }, t("plugins")),
        h("ul", { style: styles.list }, ...compatibility.checks.map((check) => h("li", {
          "data-diagnostics-entry": check.entryId,
          "data-diagnostics-status": check.status,
          key: check.entryId,
          style: styles.row,
        }, h("div", null, h("strong", null, check.entryId), h("div", { style: styles.code }, check.moduleName)), h("span", { style: styles.badge }, statusLabel(check.status))))),
        h("p", { style: styles.status }, `${t("unassessed")} (${compatibility.unassessedCount})`),
        needsRepair ? h("div", { style: styles.card },
          h("p", { style: styles.description }, t("repairHint")),
          button(t("repair"), () => void repair("repair-first-party-overlay"), true, "repair-first-party-overlay"),
        ) : null,
        h("h3", { style: styles.sectionTitle }, t("logs")),
        data.tail.entries.length === 0
          ? h("p", { style: styles.status }, t("noLogs"))
          : h("div", { "data-diagnostics-log": true, style: styles.log }, ...data.tail.entries.map((entry) => h("p", {
              key: entry.cursor,
              style: styles.logLine,
            }, `${entry.timestamp} ${entry.stream} ${entry.code} ${entry.text}`))),
      ) : null);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "diagnostics-ui: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
        name: "settings.plugins.tab",
        id: "workbench",
        order: 5,
        label: () => t("tab"),
        locale: NS,
        inject: () => ({ api: createApi(ctx), t }),
      }, DiagnosticsTab));
    }

    exports.EXPECTED_DSH_VERSION = EXPECTED_DSH_VERSION;
    exports.REQUIRED_ENTRIES = REQUIRED_ENTRIES;
    exports.DiagnosticsTab = DiagnosticsTab;
    exports.assessWorkbenchCompatibility = assessWorkbenchCompatibility;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
