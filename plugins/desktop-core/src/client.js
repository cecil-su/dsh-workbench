window.__ModuleLoader__.load({
  id: "@dsh-workbench/desktop-core",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const NS = "dshWorkbench.profiles";
    const inject = ["slots", "locale"];
    const dictionaries = {
      zh: {
        nav: "配置档案",
        title: "配置档案",
        description: "每个档案拥有独立的 DSH 数据、工作目录和浏览器状态。",
        createPlaceholder: "新档案名称",
        create: "创建",
        loading: "正在读取配置档案…",
        retry: "重试",
        active: "当前",
        archived: "已归档",
        select: "切换",
        rename: "重命名",
        save: "保存",
        cancel: "取消",
        archive: "归档",
        restore: "恢复",
        unavailable: "Workbench 档案接口不可用。",
        failed: "操作失败，请重试。",
      },
      en: {
        nav: "Profiles",
        title: "Profiles",
        description: "Each profile has isolated DSH data, workspace, and browser state.",
        createPlaceholder: "New profile name",
        create: "Create",
        loading: "Reading profiles…",
        retry: "Retry",
        active: "Active",
        archived: "Archived",
        select: "Switch",
        rename: "Rename",
        save: "Save",
        cancel: "Cancel",
        archive: "Archive",
        restore: "Restore",
        unavailable: "The Workbench profile API is unavailable.",
        failed: "The operation failed. Try again.",
      },
    };

    const styles = {
      section: {
        color: "var(--dsw-alias-label-primary)",
        display: "flex",
        flexDirection: "column",
        gap: "18px",
        maxWidth: "760px",
        width: "100%",
      },
      heading: { display: "flex", flexDirection: "column", gap: "6px" },
      title: { fontSize: "20px", lineHeight: "28px", margin: 0 },
      description: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "13px",
        lineHeight: "20px",
        margin: 0,
      },
      createForm: { display: "flex", gap: "8px" },
      input: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "8px",
        color: "var(--dsw-alias-label-primary)",
        flex: 1,
        font: "inherit",
        minWidth: 0,
        padding: "8px 10px",
      },
      button: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "8px",
        color: "var(--dsw-alias-label-primary)",
        cursor: "pointer",
        font: "inherit",
        padding: "7px 11px",
      },
      primaryButton: {
        background: "var(--dsw-alias-state-business-primary)",
        border: "1px solid transparent",
        borderRadius: "8px",
        color: "white",
        cursor: "pointer",
        font: "inherit",
        padding: "7px 12px",
      },
      list: { display: "flex", flexDirection: "column", gap: "10px", margin: 0, padding: 0 },
      row: {
        alignItems: "center",
        background: "var(--dsw-alias-bg-layer-3)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "10px",
        display: "flex",
        gap: "12px",
        justifyContent: "space-between",
        listStyle: "none",
        padding: "12px 14px",
      },
      identity: { display: "flex", flex: 1, flexDirection: "column", gap: "4px", minWidth: 0 },
      nameLine: { alignItems: "center", display: "flex", flexWrap: "wrap", gap: "8px" },
      name: { fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis" },
      badge: {
        background: "var(--dsw-alias-bg-layer-1)",
        borderRadius: "999px",
        color: "var(--dsw-alias-label-secondary)",
        fontSize: "11px",
        lineHeight: "18px",
        padding: "0 7px",
      },
      actions: { display: "flex", flexWrap: "wrap", gap: "6px", justifyContent: "flex-end" },
      error: { color: "var(--dsw-alias-state-error-primary)", fontSize: "13px", margin: 0 },
      status: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", margin: 0 },
    };

    function profileApi() {
      const api = globalThis.dshWorkbench?.profiles;
      const methods = ["archive", "create", "list", "rename", "restore", "select"];
      if (!api || !methods.every((name) => typeof api[name] === "function")) {
        throw new Error("Workbench profile API is unavailable");
      }
      return api;
    }

    function ProfilesSection({ api, t }) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [newName, setNewName] = React.useState("");
      const [editingId, setEditingId] = React.useState(null);
      const [editingName, setEditingName] = React.useState("");

      const refresh = React.useCallback(async () => {
        setError("");
        try {
          setSnapshot(await api.list());
        } catch {
          setError(t("unavailable"));
        }
      }, [api, t]);

      React.useEffect(() => {
        void refresh();
      }, [refresh]);

      const run = async (operation) => {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          setSnapshot(await operation());
        } catch {
          setError(t("failed"));
        } finally {
          setBusy(false);
        }
      };

      const createProfile = (event) => {
        event.preventDefault();
        const name = newName.trim();
        if (!name) return;
        void run(async () => {
          const next = await api.create(name);
          setNewName("");
          return next;
        });
      };

      const saveRename = (profileId) => {
        const name = editingName.trim();
        if (!name) return;
        void run(async () => {
          const next = await api.rename(profileId, name);
          setEditingId(null);
          setEditingName("");
          return next;
        });
      };

      const renderButton = (label, action, primary = false, disabled = false, actionId) => h("button", {
        ...(actionId ? { "data-profile-action": actionId } : {}),
        disabled: busy || disabled,
        onClick: action,
        style: { ...(primary ? styles.primaryButton : styles.button), opacity: busy || disabled ? 0.55 : 1 },
        type: "button",
      }, label);

      return h("section", { style: styles.section, "data-workbench-profiles": true },
        h("header", { style: styles.heading },
          h("h2", { style: styles.title }, t("title")),
          h("p", { style: styles.description }, t("description")),
        ),
        h("form", { onSubmit: createProfile, style: styles.createForm },
          h("input", {
            "aria-label": t("createPlaceholder"),
            disabled: busy,
            maxLength: 80,
            onChange: (event) => setNewName(event.currentTarget.value),
            placeholder: t("createPlaceholder"),
            style: styles.input,
            value: newName,
          }),
          h("button", {
            disabled: busy || !newName.trim(),
            style: { ...styles.primaryButton, opacity: busy || !newName.trim() ? 0.55 : 1 },
            type: "submit",
          }, t("create")),
        ),
        error ? h("p", { role: "alert", style: styles.error }, error, " ",
          h("button", { onClick: () => void refresh(), style: styles.button, type: "button" }, t("retry")),
        ) : null,
        snapshot === null && !error ? h("p", { style: styles.status }, t("loading")) : null,
        snapshot ? h("ul", { style: styles.list }, snapshot.profiles.map((profile) => {
          const active = profile.id === snapshot.activeProfileId;
          const editing = editingId === profile.id;
          return h("li", { key: profile.id, style: styles.row, "data-profile-id": profile.id },
            h("div", { style: styles.identity },
              editing ? h("input", {
                autoFocus: true,
                maxLength: 80,
                onChange: (event) => setEditingName(event.currentTarget.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter") saveRename(profile.id);
                  if (event.key === "Escape") setEditingId(null);
                },
                style: styles.input,
                value: editingName,
              }) : h("div", { style: styles.nameLine },
                h("strong", { style: styles.name }, profile.name),
                active ? h("span", { style: styles.badge }, t("active")) : null,
                profile.archived ? h("span", { style: styles.badge }, t("archived")) : null,
              ),
            ),
            h("div", { style: styles.actions },
              editing
                ? [
                    renderButton(t("save"), () => saveRename(profile.id), true, !editingName.trim(), "save"),
                    renderButton(t("cancel"), () => setEditingId(null), false, false, "cancel"),
                  ]
                : [
                    !active && !profile.archived
                      ? renderButton(t("select"), () => void run(() => api.select(profile.id)), true, false, "select")
                      : null,
                    !profile.archived
                      ? renderButton(t("rename"), () => {
                          setEditingId(profile.id);
                          setEditingName(profile.name);
                        }, false, false, "rename")
                      : null,
                    !active && !profile.archived
                      ? renderButton(t("archive"), () => void run(() => api.archive(profile.id)), false, false, "archive")
                      : null,
                    profile.archived
                      ? renderButton(t("restore"), () => void run(() => api.restore(profile.id)), false, false, "restore")
                      : null,
                  ],
            ),
          );
        })) : null,
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "desktop-core: profile dictionaries");
      const t = ctx.locale.bind(NS);
      const injected = () => ({ api: profileApi(), t });
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-workbench-profiles",
        order: 5,
        label: () => t("nav"),
        inject: injected,
      }, ProfilesSection));
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
