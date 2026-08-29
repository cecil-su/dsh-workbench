window.__ModuleLoader__.load({
  id: "@dsh-workbench/task-platform",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const inject = ["slots", "locale"];
    const NS = "dshWorkbench.taskPlatform";
    const ROUTE = "/workbench/task-platform";

    const dictionaries = {
      zh: {
        nav: "任务平台", title: "AI 任务控制中心", description: "项目、Owner、阶段执行与证据的统一工作台",
        close: "关闭任务平台", refresh: "刷新", loading: "正在同步平台状态…", error: "任务平台暂时不可用。",
        projects: "项目", tasks: "任务", allTasks: "全部任务", noProjects: "还没有项目", noTasks: "当前项目没有任务", selectTask: "选择一个任务查看详情",
        overview: "总览", work: "执行", evidence: "证据", governance: "治理", schema: "Schema", updated: "已同步",
        activeTasks: "活跃任务", blockedTasks: "阻塞任务", pendingApprovals: "待审批", openSessions: "运行会话",
        newProject: "新建项目", newTask: "登记任务", newDocument: "新增文档", cancel: "取消", create: "创建",
        projectKey: "项目键", projectName: "项目名称", workspacePath: "受管仓库路径", descriptionField: "描述",
        taskTitle: "任务标题", goal: "目标", priority: "优先级", risk: "风险", nextAction: "唯一下一步",
        taskDetail: "任务详情", owner: "Owner", ownerKey: "稳定 Owner key", epoch: "Epoch", status: "状态", version: "版本",
        confirm: "确认任务并分配 Owner", transferOwner: "转移 Owner", newOwner: "新 Owner key", transition: "更新任务状态", reason: "变更原因", blocker: "阻塞因素", recovery: "恢复条件", apply: "应用变更",
        assignments: "阶段执行", stage: "阶段", role: "角色", dispatch: "分发", report: "提交报告", accept: "接受", reject: "拒绝",
        documents: "平台文档", documentKey: "文档键", documentTitle: "文档标题", content: "内容",
        workspace: "Git 状态", observeWorkspace: "读取实际 Git 状态", expected: "期望", actual: "实际",
        sessions: "会话时间线", artifacts: "产物", workflows: "Prompt / Workflow", analytics: "流程分析",
        approvals: "审批队列", requestApproval: "发起审批", kind: "审批类型", audit: "审计日志",
        noData: "暂无数据", humanConfirmation: "草稿不会自动激活；确认和首次 Owner 分配必须由人完成。",
        projectHint: "先创建或选择项目，再登记任务。", taskHint: "围绕 Owner 的唯一下一步推进，而不是围绕临时会话推进。",
      },
      en: {
        nav: "Task platform", title: "AI task control center", description: "One workspace for projects, Owners, stage execution, and evidence",
        close: "Close task platform", refresh: "Refresh", loading: "Synchronizing platform state…", error: "Task platform is temporarily unavailable.",
        projects: "Projects", tasks: "Tasks", allTasks: "All tasks", noProjects: "No projects yet", noTasks: "No tasks in this project", selectTask: "Select a task to inspect it",
        overview: "Overview", work: "Execution", evidence: "Evidence", governance: "Governance", schema: "Schema", updated: "Synced",
        activeTasks: "Active tasks", blockedTasks: "Blocked tasks", pendingApprovals: "Pending approvals", openSessions: "Open sessions",
        newProject: "New project", newTask: "Register task", newDocument: "Add document", cancel: "Cancel", create: "Create",
        projectKey: "Project key", projectName: "Project name", workspacePath: "Managed repository path", descriptionField: "Description",
        taskTitle: "Task title", goal: "Goal", priority: "Priority", risk: "Risk", nextAction: "Single next action",
        taskDetail: "Task detail", owner: "Owner", ownerKey: "Stable Owner key", epoch: "Epoch", status: "Status", version: "Version",
        confirm: "Confirm task and assign Owner", transferOwner: "Transfer Owner", newOwner: "New Owner key", transition: "Update task state", reason: "Change reason", blocker: "Blocker", recovery: "Recovery condition", apply: "Apply change",
        assignments: "Stage execution", stage: "Stage", role: "Role", dispatch: "Dispatch", report: "Submit report", accept: "Accept", reject: "Reject",
        documents: "Platform documents", documentKey: "Document key", documentTitle: "Document title", content: "Content",
        workspace: "Git state", observeWorkspace: "Observe actual Git state", expected: "Expected", actual: "Actual",
        sessions: "Session timeline", artifacts: "Artifacts", workflows: "Prompt / Workflow", analytics: "Process analytics",
        approvals: "Approval queue", requestApproval: "Request approval", kind: "Approval kind", audit: "Audit log",
        noData: "No data yet", humanConfirmation: "A draft is inactive; confirmation and initial Owner assignment remain a human action.",
        projectHint: "Create or select a project before registering tasks.", taskHint: "Advance the Owner's single next action, not a temporary conversation.",
      },
    };

    const c = {
      base: "var(--dsw-alias-bg-base)", layer1: "var(--dsw-alias-bg-layer-1)", layer2: "var(--dsw-alias-bg-layer-2)",
      border: "var(--dsw-alias-border-l1)", borderStrong: "var(--dsw-alias-border-l2)", brand: "var(--dsw-alias-brand-primary)",
      text: "var(--dsw-alias-label-primary)", muted: "var(--dsw-alias-label-secondary)", danger: "var(--dsw-alias-state-error-primary)",
      warn: "var(--dsw-alias-state-warn-primary)", success: "var(--dsw-alias-state-success-primary)",
    };
    const styles = {
      launcher: { alignItems: "center", background: "transparent", border: 0, borderRadius: "8px", color: c.text, cursor: "pointer", display: "flex", font: "inherit", gap: "9px", justifyContent: "center", minHeight: "36px", padding: "7px 9px", width: "100%" },
      launcherIcon: { alignItems: "center", background: c.brand, borderRadius: "8px", color: "white", display: "inline-flex", fontSize: "12px", fontWeight: 800, height: "24px", justifyContent: "center", width: "24px" },
      overlay: { background: c.base, inset: 0, pointerEvents: "auto", position: "fixed", zIndex: 80 },
      app: { color: c.text, display: "grid", fontFamily: "inherit", gridTemplateRows: "64px minmax(0, 1fr)", height: "100%", minWidth: 0 },
      topbar: { alignItems: "center", background: c.layer1, borderBottom: `1px solid ${c.border}`, display: "flex", gap: "16px", padding: "0 20px" },
      brand: { alignItems: "center", display: "flex", gap: "11px", minWidth: "260px" },
      brandMark: { alignItems: "center", background: c.brand, borderRadius: "10px", color: "white", display: "flex", fontSize: "13px", fontWeight: 800, height: "34px", justifyContent: "center", width: "34px" },
      title: { fontSize: "15px", fontWeight: 700, lineHeight: "20px", margin: 0 },
      subtitle: { color: c.muted, fontSize: "11px", lineHeight: "16px", margin: 0 },
      topActions: { alignItems: "center", display: "flex", gap: "8px", marginLeft: "auto" },
      body: { display: "grid", gridTemplateColumns: "292px minmax(0, 1fr)", minHeight: 0 },
      rail: { background: c.layer1, borderRight: `1px solid ${c.border}`, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" },
      railSection: { borderBottom: `1px solid ${c.border}`, padding: "14px" },
      railHeading: { alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: "9px" },
      eyebrow: { color: c.muted, fontSize: "10px", fontWeight: 700, letterSpacing: ".08em", margin: 0, textTransform: "uppercase" },
      projectSelect: { background: c.layer2, border: `1px solid ${c.borderStrong}`, borderRadius: "8px", color: c.text, font: "inherit", minHeight: "38px", padding: "7px 9px", width: "100%" },
      taskList: { display: "flex", flex: 1, flexDirection: "column", gap: "6px", listStyle: "none", margin: 0, minHeight: 0, overflow: "auto", padding: "10px" },
      taskRow: { background: "transparent", border: "1px solid transparent", borderRadius: "9px", color: c.text, cursor: "pointer", display: "flex", flexDirection: "column", gap: "5px", padding: "10px", textAlign: "left", width: "100%" },
      taskSelected: { background: c.layer2, borderColor: c.borderStrong },
      taskTitle: { fontSize: "13px", fontWeight: 650, lineHeight: "18px" },
      meta: { color: c.muted, fontSize: "11px", lineHeight: "16px", overflowWrap: "anywhere" },
      main: { minHeight: 0, overflow: "auto", padding: "22px 24px 40px" },
      mainInner: { margin: "0 auto", maxWidth: "1280px" },
      pageHeader: { alignItems: "flex-start", display: "flex", gap: "16px", justifyContent: "space-between", marginBottom: "18px" },
      pageTitle: { fontSize: "24px", letterSpacing: "-.02em", lineHeight: "32px", margin: 0 },
      pageDescription: { color: c.muted, fontSize: "13px", lineHeight: "20px", margin: "4px 0 0" },
      actions: { alignItems: "center", display: "flex", flexWrap: "wrap", gap: "8px" },
      tabs: { borderBottom: `1px solid ${c.border}`, display: "flex", gap: "4px", marginBottom: "18px" },
      tab: { background: "transparent", border: 0, borderBottom: "2px solid transparent", color: c.muted, cursor: "pointer", font: "inherit", fontSize: "13px", fontWeight: 600, padding: "10px 12px" },
      tabActive: { borderBottomColor: c.brand, color: c.text },
      metrics: { display: "grid", gap: "10px", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", marginBottom: "14px" },
      metric: { background: c.layer1, border: `1px solid ${c.border}`, borderRadius: "12px", padding: "14px" },
      metricValue: { fontSize: "24px", fontWeight: 750, lineHeight: "30px" },
      metricLabel: { color: c.muted, fontSize: "11px", marginTop: "3px" },
      grid2: { display: "grid", gap: "12px", gridTemplateColumns: "repeat(2, minmax(280px, 1fr))" },
      gridWide: { display: "grid", gap: "12px", gridTemplateColumns: "minmax(340px, 1.35fr) minmax(280px, .65fr)" },
      card: { background: c.layer1, border: `1px solid ${c.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "11px", minWidth: 0, padding: "15px" },
      cardHeader: { alignItems: "center", display: "flex", gap: "8px", justifyContent: "space-between" },
      cardTitle: { fontSize: "14px", fontWeight: 700, margin: 0 },
      bodyText: { fontSize: "13px", lineHeight: "20px", margin: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
      form: { background: c.layer2, border: `1px solid ${c.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "10px", marginBottom: "14px", padding: "15px" },
      field: { display: "flex", flex: "1 1 160px", flexDirection: "column", gap: "5px", minWidth: "145px" },
      label: { color: c.muted, fontSize: "11px", fontWeight: 600 },
      input: { background: c.base, border: `1px solid ${c.borderStrong}`, borderRadius: "8px", color: c.text, font: "inherit", minHeight: "36px", padding: "7px 9px", width: "100%" },
      textarea: { background: c.base, border: `1px solid ${c.borderStrong}`, borderRadius: "8px", color: c.text, font: "inherit", minHeight: "84px", padding: "9px", resize: "vertical", width: "100%" },
      button: { background: c.layer2, border: `1px solid ${c.borderStrong}`, borderRadius: "8px", color: c.text, cursor: "pointer", font: "inherit", fontSize: "12px", fontWeight: 600, minHeight: "34px", padding: "7px 11px" },
      primary: { background: c.brand, border: "1px solid transparent", borderRadius: "8px", color: "white", cursor: "pointer", font: "inherit", fontSize: "12px", fontWeight: 650, minHeight: "34px", padding: "7px 12px" },
      iconButton: { alignItems: "center", background: "transparent", border: `1px solid ${c.border}`, borderRadius: "8px", color: c.text, cursor: "pointer", display: "flex", font: "inherit", height: "34px", justifyContent: "center", width: "34px" },
      row: { background: c.layer2, border: `1px solid ${c.border}`, borderRadius: "9px", display: "flex", flexDirection: "column", gap: "5px", padding: "10px" },
      list: { display: "flex", flexDirection: "column", gap: "7px", listStyle: "none", margin: 0, maxHeight: "420px", overflow: "auto", padding: 0 },
      badges: { display: "flex", flexWrap: "wrap", gap: "6px" },
      badge: { background: c.layer2, border: `1px solid ${c.border}`, borderRadius: "999px", fontSize: "10px", lineHeight: "16px", padding: "2px 7px" },
      statusDot: { borderRadius: "50%", display: "inline-block", height: "7px", marginRight: "6px", width: "7px" },
      error: { background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)", border: `1px solid ${c.danger}`, borderRadius: "9px", color: c.danger, fontSize: "12px", margin: "0 0 12px", padding: "9px 11px" },
      empty: { color: c.muted, fontSize: "12px", lineHeight: "18px", margin: 0, padding: "12px 2px" },
      audit: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: "10px", lineHeight: "17px", margin: 0, maxHeight: "460px", overflow: "auto", whiteSpace: "pre-wrap" },
    };

    async function request(command, signal) {
      const response = await fetch(ROUTE, { body: JSON.stringify(command), cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json" }, method: "POST", signal });
      let payload;
      try { payload = await response.json(); } catch { throw new Error("Task platform returned invalid JSON"); }
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error?.message || "Task platform request failed");
      return payload.value;
    }
    const api = {
      snapshot: (filters, signal) => request({ action: "snapshot", ...filters }, signal),
      operations: (projectId, taskId, signal) => request({ action: "operations-snapshot", projectId, ...(taskId ? { taskId } : {}) }, signal),
      createProject: (value) => request({ action: "project-create", ...value }), draftTask: (value) => request({ action: "task-draft", ...value }),
      confirmTask: (value) => request({ action: "task-confirm", ...value }), transferOwner: (value) => request({ action: "owner-transfer", ...value }), transitionTask: (value) => request({ action: "task-transition", ...value }),
      createDocument: (value) => request({ action: "document-create", ...value }), createAssignment: (value) => request({ action: "assignment-create", ...value }),
      assignmentEvent: (value) => request({ action: "assignment-event", ...value }), requestApproval: (value) => request({ action: "approval-request", ...value }),
      decideApproval: (value) => request({ action: "approval-decide", ...value }), observeWorkspace: (value) => request({ action: "workspace-observe", ...value }),
    };
    const commandKey = () => `web:${crypto.randomUUID()}`;
    const statusColor = (status) => status === "blocked" || status === "rejected" ? c.danger : status === "closed" || status === "accepted" || status === "completed" ? c.success : status === "pending" || status === "draft" ? c.warn : c.brand;

    function createPanelController() {
      let open = false;
      const listeners = new Set();
      return {
        getSnapshot: () => open,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        set(value) { if (open === value) return; open = value; for (const listener of listeners) listener(); },
      };
    }
    function usePanelOpen(controller) { return React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => false); }
    function Field({ label, children }) { return h("label", { style: styles.field }, h("span", { style: styles.label }, label), children); }
    function Input({ value, onChange, placeholder, type }) { return h("input", { onChange: (event) => onChange(event.currentTarget.value), placeholder, style: styles.input, type: type || "text", value }); }
    function Button({ children, onClick, primary, disabled, action }) { return h("button", { "data-task-platform-action": action, disabled, onClick, style: primary ? styles.primary : styles.button, type: "button" }, children); }
    function Empty({ children }) { return h("p", { style: styles.empty }, children); }
    function Status({ value }) { return h("span", { style: styles.meta }, h("span", { style: { ...styles.statusDot, background: statusColor(value) } }), value); }
    function Card({ title, action, children, data }) { return h("section", { ...(data || {}), style: styles.card }, h("div", { style: styles.cardHeader }, h("h3", { style: styles.cardTitle }, title), action || null), children); }
    function Metric({ label, value, color }) { return h("div", { style: styles.metric }, h("div", { style: { ...styles.metricValue, ...(color ? { color } : {}) } }, String(value)), h("div", { style: styles.metricLabel }, label)); }

    function TaskPlatformLauncher({ wide, t, controller }) {
      return h("button", { "aria-label": t("nav"), "data-task-platform-launcher": true, onClick: () => controller.set(true), style: styles.launcher, type: "button" }, h("span", { style: styles.launcherIcon }, "TP"), wide ? h("span", null, t("nav")) : null);
    }

    function TaskPlatformApp({ t, onClose }) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [operations, setOperations] = React.useState(null);
      const [projectId, setProjectId] = React.useState("");
      const [taskId, setTaskId] = React.useState("");
      const [tab, setTab] = React.useState("overview");
      const [composer, setComposer] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [projectDraft, setProjectDraft] = React.useState({ key: "", name: "", description: "", workspacePath: "" });
      const [taskDraft, setTaskDraft] = React.useState({ title: "", goal: "", priority: "2", risk: "", nextAction: "" });
      const [documentDraft, setDocumentDraft] = React.useState({ key: "", title: "", content: "" });
      const [ownerKey, setOwnerKey] = React.useState("");
      const [ownerTransfer, setOwnerTransfer] = React.useState({ key: "", reason: "" });
      const [transition, setTransition] = React.useState({ status: "in_progress", nextAction: "", blocker: "", recoveryCondition: "", reason: "" });
      const [assignmentDraft, setAssignmentDraft] = React.useState({ stage: "scout", role: "stage_agent" });
      const [approvalKind, setApprovalKind] = React.useState("git-integration");

      const load = React.useCallback(async (signal) => {
        setBusy(true); setError("");
        try {
          const value = await api.snapshot(projectId ? { projectId } : {}, signal);
          setSnapshot(value);
          const effectiveProject = projectId || value.projects[0]?.id || "";
          if (!projectId && effectiveProject) setProjectId(effectiveProject);
          if (effectiveProject) setOperations(await api.operations(effectiveProject, taskId, signal)); else setOperations(null);
          if (taskId && !value.tasks.some((item) => item.id === taskId)) setTaskId("");
        } catch (reason) { if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { setBusy(false); }
      }, [projectId, taskId]);
      React.useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
      const mutate = async (operation) => { setBusy(true); setError(""); try { const value = await operation(); await load(); return value; } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };

      const projects = snapshot?.projects || [];
      const tasks = snapshot?.tasks || [];
      const selected = tasks.find((item) => item.id === taskId) || null;
      const project = projects.find((item) => item.id === projectId) || null;
      const counts = {
        active: tasks.filter((item) => !["draft", "closed", "cancelled"].includes(item.status)).length,
        blocked: tasks.filter((item) => item.status === "blocked").length,
        approvals: (operations?.approvals || []).filter((item) => item.status === "pending").length,
        sessions: (operations?.sessions || []).filter((item) => item.status === "open").length,
      };
      const tabs = ["overview", "work", "evidence", "governance"];

      const projectForm = composer === "project" ? h("div", { style: styles.form },
        h("div", { style: styles.cardHeader }, h("h3", { style: styles.cardTitle }, t("newProject")), h(Button, { action: "composer-cancel", onClick: () => setComposer("") }, t("cancel"))),
        h("div", { style: styles.actions }, h(Field, { label: t("projectKey") }, h(Input, { value: projectDraft.key, onChange: (key) => setProjectDraft({ ...projectDraft, key }) })), h(Field, { label: t("projectName") }, h(Input, { value: projectDraft.name, onChange: (name) => setProjectDraft({ ...projectDraft, name }) })), h(Field, { label: t("workspacePath") }, h(Input, { value: projectDraft.workspacePath, onChange: (workspacePath) => setProjectDraft({ ...projectDraft, workspacePath }) }))),
        h(Button, { action: "project-create", disabled: busy || !projectDraft.key || !projectDraft.name, onClick: () => void mutate(async () => { const value = await api.createProject({ ...projectDraft, idempotencyKey: commandKey() }); setProjectDraft({ key: "", name: "", description: "", workspacePath: "" }); setProjectId(value.id); setComposer(""); return value; }), primary: true }, t("create")),
      ) : null;
      const taskForm = composer === "task" && projectId ? h("div", { style: styles.form },
        h("div", { style: styles.cardHeader }, h("div", null, h("h3", { style: styles.cardTitle }, t("newTask")), h("p", { style: styles.meta }, t("humanConfirmation"))), h(Button, { action: "composer-cancel", onClick: () => setComposer("") }, t("cancel"))),
        h("div", { style: styles.actions }, h(Field, { label: t("taskTitle") }, h(Input, { value: taskDraft.title, onChange: (title) => setTaskDraft({ ...taskDraft, title }) })), h(Field, { label: t("priority") }, h("select", { onChange: (event) => setTaskDraft({ ...taskDraft, priority: event.currentTarget.value }), style: styles.input, value: taskDraft.priority }, ...[0,1,2,3,4].map((value) => h("option", { key: value, value }, `P${value}`)))), h(Field, { label: t("nextAction") }, h(Input, { value: taskDraft.nextAction, onChange: (nextAction) => setTaskDraft({ ...taskDraft, nextAction }) }))),
        h(Field, { label: t("goal") }, h("textarea", { onChange: (event) => setTaskDraft({ ...taskDraft, goal: event.currentTarget.value }), style: styles.textarea, value: taskDraft.goal })),
        h(Button, { action: "task-draft", disabled: busy || !taskDraft.title || !taskDraft.goal, onClick: () => void mutate(async () => { const value = await api.draftTask({ ...taskDraft, priority: Number(taskDraft.priority), projectId, idempotencyKey: commandKey() }); setTaskDraft({ title: "", goal: "", priority: "2", risk: "", nextAction: "" }); setTaskId(value.id); setComposer(""); return value; }), primary: true }, t("create")),
      ) : null;

      const taskDetail = selected ? h(Card, { title: t("taskDetail"), data: { "data-task-platform-task": selected.id } },
        h("div", { style: styles.badges }, h("span", { style: styles.badge }, selected.status), h("span", { style: styles.badge }, `P${selected.priority}`), h("span", { style: styles.badge }, `${t("owner")}: ${selected.ownerKey || "-"}@${selected.ownershipEpoch}`), h("span", { style: styles.badge }, `${t("version")}: ${selected.version}`)),
        h("p", { style: styles.bodyText }, selected.goal), selected.nextAction ? h("div", { style: { ...styles.row, borderLeft: `3px solid ${c.brand}` } }, h("span", { style: styles.label }, t("nextAction")), h("strong", null, selected.nextAction)) : null,
        (operations?.dependencies || []).length ? h("div", { "data-task-platform-graph": true, style: styles.badges }, ...operations.dependencies.map((item) => h("span", { key: `${item.taskId}:${item.dependsOnTaskId}:${item.type}`, style: styles.badge }, `${item.taskId} —${item.type}→ ${item.dependsOnTaskId}`))) : null,
        selected.status === "draft" ? h("div", { style: styles.actions }, h(Field, { label: t("ownerKey") }, h(Input, { value: ownerKey, onChange: setOwnerKey })), h(Button, { action: "task-confirm", disabled: busy || !ownerKey, onClick: () => void mutate(() => api.confirmTask({ taskId: selected.id, ownerKey, expectedVersion: selected.version, idempotencyKey: commandKey() })), primary: true }, t("confirm"))) : null,
      ) : h(Card, { title: t("taskDetail") }, h(Empty, null, t("selectTask")));

      const transitionCard = selected && selected.status !== "draft" && !["closed", "cancelled"].includes(selected.status) ? h(Card, { title: t("transition") },
        h("div", { style: styles.actions }, h(Field, { label: t("status") }, h("select", { onChange: (event) => setTransition({ ...transition, status: event.currentTarget.value }), style: styles.input, value: transition.status }, ...["open","in_progress","blocked","deferred","closed","cancelled"].map((value) => h("option", { key: value, value }, value)))), h(Field, { label: t("nextAction") }, h(Input, { value: transition.nextAction, onChange: (nextAction) => setTransition({ ...transition, nextAction }) }))),
        transition.status === "blocked" ? h("div", { style: styles.actions }, h(Field, { label: t("blocker") }, h(Input, { value: transition.blocker, onChange: (blocker) => setTransition({ ...transition, blocker }) })), h(Field, { label: t("recovery") }, h(Input, { value: transition.recoveryCondition, onChange: (recoveryCondition) => setTransition({ ...transition, recoveryCondition }) }))) : null,
        h(Field, { label: t("reason") }, h(Input, { value: transition.reason, onChange: (reason) => setTransition({ ...transition, reason }) })),
        h(Button, { action: "task-transition", disabled: busy || !transition.reason, onClick: () => void mutate(() => api.transitionTask({ ...transition, taskId: selected.id, expectedVersion: selected.version, expectedOwnershipEpoch: selected.ownershipEpoch, idempotencyKey: commandKey() })), primary: true }, t("apply")),
      ) : null;

      const overview = h(React.Fragment, null,
        h("div", { style: styles.metrics }, h(Metric, { label: t("activeTasks"), value: counts.active }), h(Metric, { color: counts.blocked ? c.danger : undefined, label: t("blockedTasks"), value: counts.blocked }), h(Metric, { color: counts.approvals ? c.warn : undefined, label: t("pendingApprovals"), value: counts.approvals }), h(Metric, { label: t("openSessions"), value: counts.sessions })),
        h("div", { style: styles.gridWide }, taskDetail, transitionCard || h(Card, { title: t("nextAction") }, h(Empty, null, selected ? t("taskHint") : t("selectTask"))))
      );

      const assignments = h(Card, { title: t("assignments"), data: { "data-task-platform-assignments": true } },
        selected && selected.status !== "draft" ? h("div", { style: styles.actions }, h(Field, { label: t("stage") }, h(Input, { value: assignmentDraft.stage, onChange: (stage) => setAssignmentDraft({ ...assignmentDraft, stage }) })), h(Field, { label: t("role") }, h(Input, { value: assignmentDraft.role, onChange: (role) => setAssignmentDraft({ ...assignmentDraft, role }) })), h(Button, { action: "assignment-create", disabled: busy || !assignmentDraft.stage || !assignmentDraft.role, onClick: () => void mutate(() => api.createAssignment({ ...assignmentDraft, taskId: selected.id, expectedOwnershipEpoch: selected.ownershipEpoch, capabilitySet: ["fs:read"], sourceScope: ["workspace"], requiredArtifacts: ["stage-report"], acceptance: ["Evidence is sourced"], stopConditions: ["Stop on authorization boundary"], idempotencyKey: commandKey() })), primary: true }, t("create"))) : null,
        h("div", { style: styles.list }, ...((operations?.assignments || []).length ? operations.assignments.map((item) => h("div", { key: item.id, style: styles.row }, h("div", { style: styles.cardHeader }, h("strong", null, `${item.stage} · ${item.role}`), h(Status, { value: item.status })), h("span", { style: styles.meta }, item.id), h("div", { style: styles.actions }, item.status === "pending" ? h(Button, { action: "assignment-dispatch", disabled: busy, onClick: () => void mutate(() => api.assignmentEvent({ assignmentId: item.id, expectedOwnershipEpoch: item.ownershipEpoch, type: "dispatched", idempotencyKey: commandKey() })) }, t("dispatch")) : null, item.status === "dispatched" ? h(Button, { action: "assignment-report", disabled: busy, onClick: () => void mutate(() => api.assignmentEvent({ assignmentId: item.id, expectedOwnershipEpoch: item.ownershipEpoch, type: "reported", payload: { summary: "Reported through local Web control plane" }, idempotencyKey: commandKey() })) }, t("report")) : null, item.status === "reported" ? h(React.Fragment, null, h(Button, { action: "assignment-accept", disabled: busy, onClick: () => void mutate(() => api.assignmentEvent({ assignmentId: item.id, expectedOwnershipEpoch: item.ownershipEpoch, type: "accepted", idempotencyKey: commandKey() })), primary: true }, t("accept")), h(Button, { action: "assignment-reject", disabled: busy, onClick: () => void mutate(() => api.assignmentEvent({ assignmentId: item.id, expectedOwnershipEpoch: item.ownershipEpoch, type: "rejected", idempotencyKey: commandKey() })) }, t("reject"))) : null))) : [h(Empty, { key: "empty" }, t("noData"))]))
      );
      const documents = h(Card, { action: h(Button, { action: "document-compose", disabled: !projectId, onClick: () => setComposer(composer === "document" ? "" : "document") }, t("newDocument")), title: t("documents"), data: { "data-task-platform-documents": true } },
        composer === "document" ? h("div", { style: styles.form }, h(Field, { label: t("documentKey") }, h(Input, { value: documentDraft.key, onChange: (key) => setDocumentDraft({ ...documentDraft, key }) })), h(Field, { label: t("documentTitle") }, h(Input, { value: documentDraft.title, onChange: (title) => setDocumentDraft({ ...documentDraft, title }) })), h(Field, { label: t("content") }, h("textarea", { onChange: (event) => setDocumentDraft({ ...documentDraft, content: event.currentTarget.value }), style: styles.textarea, value: documentDraft.content })), h(Button, { action: "document-create", disabled: busy || !documentDraft.key || !documentDraft.title || !documentDraft.content, onClick: () => void mutate(async () => { const value = await api.createDocument({ projectId, ...documentDraft, authorityKind: "platform", idempotencyKey: commandKey() }); setDocumentDraft({ key: "", title: "", content: "" }); setComposer(""); return value; }), primary: true }, t("create"))) : null,
        h("div", { style: styles.list }, ...((operations?.documents || []).length ? operations.documents.map((item) => h("div", { key: item.id, style: styles.row }, h("strong", null, item.title), h("span", { style: styles.meta }, `${item.key} · ${item.authorityKind} · v${item.latestVersion}`))) : [h(Empty, { key: "empty" }, t("noData"))]))
      );
      const workspace = h(Card, { action: h(Button, { action: "workspace-observe", disabled: busy || !projectId, onClick: () => void mutate(() => api.observeWorkspace({ projectId, ...(selected ? { taskId: selected.id } : {}), idempotencyKey: commandKey() })) }, t("observeWorkspace")), title: t("workspace"), data: { "data-task-platform-workspace": true } },
        operations?.workspaceExpectation ? h("div", { style: styles.row }, h("span", { style: styles.label }, t("expected")), h("span", { style: styles.bodyText }, `${operations.workspaceExpectation.branch || "-"}@${operations.workspaceExpectation.head || "-"} · clean=${operations.workspaceExpectation.cleanRequired}`)) : h(Empty, null, t("noData")),
        ...(operations?.workspaceObservations || []).slice(0, 4).map((item) => h("div", { key: item.id, style: styles.row }, h("span", { style: styles.label }, t("actual")), h("span", { style: styles.bodyText }, `${item.branch || "-"}@${item.head || "-"} · dirty=${item.dirty}`), h("span", { style: styles.meta }, item.observedAt)))
      );
      const work = h("div", { style: styles.grid2 }, assignments, documents, workspace);

      const evidence = h("div", { style: styles.grid2 },
        h(Card, { title: t("sessions"), data: { "data-task-platform-sessions": true } }, h("div", { style: styles.list }, ...((operations?.sessions || []).length ? operations.sessions.map((item) => h("div", { key: item.id, style: styles.row }, h("div", { style: styles.cardHeader }, h("strong", null, `${item.role} · ${item.client}`), h(Status, { value: item.status })), h("span", { style: styles.meta }, `${item.model || "-"} · ${item.id}`))) : [h(Empty, { key: "empty" }, t("noData"))]))),
        h(Card, { title: t("artifacts"), data: { "data-task-platform-artifacts": true } }, h("div", { style: styles.list }, ...((operations?.artifacts || []).length ? operations.artifacts.map((item) => h("div", { key: item.id, style: styles.row }, h("strong", null, item.mediaType), h("span", { style: styles.meta }, `${item.sizeBytes} B · ${item.sensitivity}`), h("span", { style: styles.meta }, item.objectHash))) : [h(Empty, { key: "empty" }, t("noData"))]))),
        h(Card, { title: t("workflows"), data: { "data-task-platform-workflows": true } }, h("p", { style: styles.bodyText }, `${operations?.promptVersions?.length || 0} prompt versions\n${operations?.workflowVersions?.length || 0} workflow versions`)),
        h(Card, { title: t("analytics"), data: { "data-task-platform-analytics": true } }, h("p", { style: styles.bodyText }, operations?.analytics ? `tasks  ${Object.entries(operations.analytics.taskStatus).map(([key, value]) => `${key}:${value}`).join(" · ")}\nassignments  ${Object.entries(operations.analytics.assignmentStatus).map(([key, value]) => `${key}:${value}`).join(" · ")}\nsessions  ${Object.entries(operations.analytics.sessionStatus).map(([key, value]) => `${key}:${value}`).join(" · ")}` : t("noData")))
      );

      const governance = h("div", { style: styles.gridWide },
        selected && selected.status !== "draft" ? h(Card, { title: t("transferOwner"), data: { "data-task-platform-owner-transfer": true } }, h("p", { style: styles.meta }, `${t("owner")}: ${selected.ownerKey || "-"}@${selected.ownershipEpoch}`), h(Field, { label: t("newOwner") }, h(Input, { value: ownerTransfer.key, onChange: (key) => setOwnerTransfer({ ...ownerTransfer, key }) })), h(Field, { label: t("reason") }, h(Input, { value: ownerTransfer.reason, onChange: (reason) => setOwnerTransfer({ ...ownerTransfer, reason }) })), h(Button, { action: "owner-transfer", disabled: busy || !ownerTransfer.key || !ownerTransfer.reason, onClick: () => void mutate(async () => { const value = await api.transferOwner({ taskId: selected.id, newOwnerKey: ownerTransfer.key, expectedOwnershipEpoch: selected.ownershipEpoch, reason: ownerTransfer.reason, idempotencyKey: commandKey() }); setOwnerTransfer({ key: "", reason: "" }); return value; }), primary: true }, t("transferOwner"))) : null,
        h(Card, { title: t("approvals"), data: { "data-task-platform-approvals": true } }, selected ? h("div", { style: styles.actions }, h(Field, { label: t("kind") }, h(Input, { value: approvalKind, onChange: setApprovalKind })), h(Button, { action: "approval-request", disabled: busy || !approvalKind, onClick: () => void mutate(() => api.requestApproval({ projectId, taskId: selected.id, kind: approvalKind, request: { taskVersion: selected.version, ownershipEpoch: selected.ownershipEpoch }, idempotencyKey: commandKey() })), primary: true }, t("requestApproval"))) : null, h("div", { style: styles.list }, ...((operations?.approvals || []).length ? operations.approvals.map((item) => h("div", { key: item.id, style: styles.row }, h("div", { style: styles.cardHeader }, h("strong", null, item.kind), h(Status, { value: item.status })), h("span", { style: styles.meta }, item.requestedBy), item.status === "pending" ? h("div", { style: styles.actions }, h(Button, { action: "approval-approve", disabled: busy, onClick: () => void mutate(() => api.decideApproval({ approvalId: item.id, decision: "approved", reason: "Approved in local Web control plane", idempotencyKey: commandKey() })), primary: true }, t("accept")), h(Button, { action: "approval-reject", disabled: busy, onClick: () => void mutate(() => api.decideApproval({ approvalId: item.id, decision: "rejected", reason: "Rejected in local Web control plane", idempotencyKey: commandKey() })) }, t("reject"))) : null)) : [h(Empty, { key: "empty" }, t("noData"))]))),
        h(Card, { title: t("audit"), data: { "data-task-platform-audit": true } }, h("pre", { style: styles.audit }, (snapshot?.audit || []).map((item) => `${item.occurredAt}  ${item.decision.padEnd(8)}  ${item.actorKey}  ${item.command}`).join("\n") || "-"))
      );

      return h("div", { "data-task-platform": true, style: styles.app },
        h("header", { style: styles.topbar }, h("div", { style: styles.brand }, h("div", { style: styles.brandMark }, "TP"), h("div", null, h("h1", { style: styles.title }, t("title")), h("p", { style: styles.subtitle }, t("description")))), h("div", { style: styles.topActions }, snapshot ? h("span", { style: styles.meta }, `${t("schema")} ${snapshot.schemaVersion} · ${t("updated")}`) : null, h(Button, { action: "refresh", disabled: busy, onClick: () => void load() }, t("refresh")), h("button", { "aria-label": t("close"), "data-task-platform-action": "close", onClick: onClose, style: styles.iconButton, type: "button" }, "×"))),
        h("div", { style: styles.body },
          h("aside", { style: styles.rail }, h("div", { style: styles.railSection }, h("div", { style: styles.railHeading }, h("p", { style: styles.eyebrow }, t("projects")), h("button", { "aria-label": t("newProject"), onClick: () => setComposer("project"), style: styles.iconButton, type: "button" }, "+")), h("select", { onChange: (event) => { setProjectId(event.currentTarget.value); setTaskId(""); }, style: styles.projectSelect, value: projectId }, h("option", { value: "" }, t("projects")), ...projects.map((item) => h("option", { key: item.id, value: item.id }, `${item.key} · ${item.name}`)))), h("div", { style: { ...styles.railHeading, margin: "12px 14px 4px" } }, h("p", { style: styles.eyebrow }, t("tasks")), h("button", { "aria-label": t("newTask"), disabled: !projectId, onClick: () => setComposer("task"), style: styles.iconButton, type: "button" }, "+")), h("div", { "data-task-platform-list": true, style: styles.taskList }, ...(tasks.length ? tasks.map((item) => h("button", { "data-task-id": item.id, key: item.id, onClick: () => { setTaskId(item.id); setTab("overview"); }, style: { ...styles.taskRow, ...(item.id === taskId ? styles.taskSelected : {}) }, type: "button" }, h("span", { style: styles.taskTitle }, item.title), h(Status, { value: item.status }), h("span", { style: styles.meta }, `${item.ownerKey || "-"}@${item.ownershipEpoch} · P${item.priority}`), item.nextAction ? h("span", { style: styles.meta }, `→ ${item.nextAction}`) : null)) : [h(Empty, { key: "empty" }, projectId ? t("noTasks") : t("projectHint"))]))),
          h("main", { style: styles.main }, h("div", { style: styles.mainInner }, h("div", { style: styles.pageHeader }, h("div", null, h("h2", { style: styles.pageTitle }, selected?.title || project?.name || t("title")), h("p", { style: styles.pageDescription }, selected?.nextAction ? `${t("nextAction")}: ${selected.nextAction}` : project?.description || t("taskHint"))), h("div", { style: styles.actions }, h(Button, { action: "new-project", onClick: () => setComposer("project") }, t("newProject")), h(Button, { action: "new-task", disabled: !projectId, onClick: () => setComposer("task"), primary: true }, t("newTask")))), projectForm, taskForm, error ? h("p", { role: "alert", style: styles.error }, error) : null, busy && !snapshot ? h("p", { style: styles.empty }, t("loading")) : null, h("nav", { "aria-label": t("title"), style: styles.tabs }, ...tabs.map((value) => h("button", { key: value, onClick: () => setTab(value), style: { ...styles.tab, ...(tab === value ? styles.tabActive : {}) }, type: "button" }, t(value)))), tab === "overview" ? overview : tab === "work" ? work : tab === "evidence" ? evidence : governance))
        )
      );
    }

    function TaskPlatformOverlay({ t, controller }) {
      const open = usePanelOpen(controller);
      if (!open) return null;
      return h("div", { "data-task-platform-overlay": true, role: "dialog", "aria-modal": true, style: styles.overlay }, h(TaskPlatformApp, { onClose: () => controller.set(false), t }));
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "task-platform: dictionaries");
      const t = ctx.locale.bind(NS);
      const controller = createPanelController();
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "dsh-workbench-task-platform", order: -20, label: () => t("nav"), inject: () => ({ controller, t }) }, TaskPlatformLauncher));
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "dsh-workbench-task-platform", order: 20, label: () => t("nav"), inject: () => ({ controller, t }) }, TaskPlatformOverlay));
    }
    exports.TaskPlatformApp = TaskPlatformApp;
    exports.NS = NS;
    exports.ROUTE = ROUTE;
    exports.api = api;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
