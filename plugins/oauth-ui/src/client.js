window.__ModuleLoader__.load({
  id: "@dsh-workbench/oauth-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const NS = "dshWorkbench.authorization";
    const ROUTE = "/workbench/authorization";
    const inject = ["slots", "locale"];
    const dictionaries = {
      zh: {
        nav: "登录与授权",
        title: "登录与授权",
        description: "登录流程和凭据由当前档案中的 DSH 官方服务处理，Workbench 不读取或保存凭据值。",
        loading: "正在读取授权状态…",
        retry: "重试",
        configured: "已登录",
        unconfigured: "未登录",
        busy: "进行中",
        orphan: "来源插件未加载",
        signOut: "退出登录",
        cancel: "取消",
        submit: "继续",
        decline: "暂不授权",
        openPage: "在浏览器中继续",
        code: "验证码",
        apiKey: "API 密钥",
        grant: "OAuth 授权",
        unavailable: "授权服务暂不可用。",
        failed: "授权操作失败，请重试。",
        empty: "当前没有可用的官方授权方式。",
      },
      en: {
        nav: "Sign-in & authorization",
        title: "Sign-in & authorization",
        description: "DSH official services handle sign-in and credentials inside the current profile. Workbench never reads or stores credential values.",
        loading: "Reading authorization status…",
        retry: "Retry",
        configured: "Signed in",
        unconfigured: "Not signed in",
        busy: "In progress",
        orphan: "Owner plugin not loaded",
        signOut: "Sign out",
        cancel: "Cancel",
        submit: "Continue",
        decline: "Not now",
        openPage: "Continue in browser",
        code: "Code",
        apiKey: "API key",
        grant: "OAuth grant",
        unavailable: "Authorization service is unavailable.",
        failed: "Authorization failed. Try again.",
        empty: "No official authorization methods are available.",
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
      list: { display: "flex", flexDirection: "column", gap: "10px", margin: 0, padding: 0 },
      row: {
        background: "var(--dsw-alias-bg-layer-3)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "10px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        listStyle: "none",
        padding: "14px",
      },
      rowHead: {
        alignItems: "center",
        display: "flex",
        gap: "12px",
        justifyContent: "space-between",
      },
      identity: { display: "flex", flex: 1, flexDirection: "column", gap: "4px", minWidth: 0 },
      nameLine: { alignItems: "center", display: "flex", flexWrap: "wrap", gap: "8px" },
      name: { fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis" },
      key: {
        color: "var(--dsw-alias-label-tertiary)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "11px",
      },
      badge: {
        background: "var(--dsw-alias-bg-layer-1)",
        borderRadius: "999px",
        color: "var(--dsw-alias-label-secondary)",
        fontSize: "11px",
        lineHeight: "18px",
        padding: "0 7px",
      },
      actions: { display: "flex", flexWrap: "wrap", gap: "6px", justifyContent: "flex-end" },
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
      attempt: {
        background: "var(--dsw-alias-bg-layer-1)",
        borderRadius: "8px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "12px",
      },
      notice: { fontSize: "13px", lineHeight: "20px", margin: 0 },
      code: {
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: "6px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "15px",
        letterSpacing: "0.08em",
        padding: "7px 9px",
        userSelect: "all",
      },
      input: {
        background: "var(--dsw-alias-bg-layer-3)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "8px",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        padding: "8px 10px",
        width: "100%",
      },
      prompt: { display: "flex", flexDirection: "column", gap: "8px" },
      error: { color: "var(--dsw-alias-state-error-primary)", fontSize: "13px", margin: 0 },
      status: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", margin: 0 },
      link: { color: "var(--dsw-alias-state-business-primary)", fontSize: "13px" },
    };

    async function request(command, signal) {
      const response = await fetch(ROUTE, {
        body: JSON.stringify(command),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Authorization service returned an invalid response");
      }
      if (!response.ok || payload?.ok !== true) {
        const error = new Error(payload?.error?.message || "Authorization request failed");
        error.code = payload?.error?.code;
        throw error;
      }
      return payload.value;
    }

    const api = Object.freeze({
      snapshot: () => request({ action: "snapshot" }),
      begin: (attemptId, key, method, signal) => request({ action: "begin", attemptId, key, method }, signal),
      state: (attemptId) => request({ action: "state", attemptId }),
      answer: (attemptId, promptId, answer) => request({ action: "answer", attemptId, promptId, answer }),
      decline: (attemptId, promptId) => request({ action: "decline", attemptId, promptId }),
      cancel: (key) => request({ action: "cancel", key }),
      delete: (key) => request({ action: "delete", key }),
    });

    function AuthorizationSection({ t }) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState("");
      const [busyKey, setBusyKey] = React.useState(null);
      const [attempt, setAttempt] = React.useState(null);
      const [answer, setAnswer] = React.useState("");
      const [promptBusy, setPromptBusy] = React.useState(false);
      const attemptAbort = React.useRef(null);

      const refresh = React.useCallback(async () => {
        try {
          setSnapshot(await api.snapshot());
          setError("");
        } catch {
          setError(t("unavailable"));
        }
      }, [t]);

      React.useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 2000);
        return () => clearInterval(timer);
      }, [refresh]);

      React.useEffect(() => {
        const promptId = attempt?.state?.prompt?.id;
        setAnswer("");
        setPromptBusy(false);
        void promptId;
      }, [attempt?.state?.prompt?.id]);

      React.useEffect(() => {
        if (!attempt) return undefined;
        let stopped = false;
        const tick = async () => {
          try {
            const state = await api.state(attempt.attemptId);
            if (!stopped) setAttempt((current) => current?.attemptId === attempt.attemptId
              ? { ...current, state }
              : current);
          } catch (requestError) {
            if (!stopped && requestError?.code !== "ATTEMPT_NOT_FOUND") setError(t("failed"));
          }
        };
        void tick();
        const timer = setInterval(() => void tick(), 500);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, [attempt?.attemptId, t]);

      React.useEffect(() => () => attemptAbort.current?.abort(), []);

      const start = (entry, method) => {
        if (busyKey || attempt) return;
        const attemptId = crypto.randomUUID();
        const controller = new AbortController();
        attemptAbort.current = controller;
        setAttempt({ attemptId, key: entry.key, method: method.id, state: null });
        setBusyKey(entry.key);
        setError("");
        void api.begin(attemptId, entry.key, method.id, controller.signal)
          .catch((requestError) => {
            if (requestError?.name !== "AbortError") setError(requestError?.message || t("failed"));
          })
          .finally(() => {
            if (attemptAbort.current === controller) attemptAbort.current = null;
            setAttempt((current) => current?.attemptId === attemptId ? null : current);
            setBusyKey((current) => current === entry.key ? null : current);
            void refresh();
          });
      };

      const run = async (entry, operation) => {
        if (busyKey) return;
        setBusyKey(entry.key);
        setError("");
        try {
          await operation();
          await refresh();
        } catch (requestError) {
          setError(requestError?.message || t("failed"));
        } finally {
          setBusyKey(null);
        }
      };

      const cancel = (entry) => {
        setError("");
        void api.cancel(entry.key).then(() => {
          if (attempt?.key === entry.key) {
            attemptAbort.current?.abort();
            setAttempt(null);
          }
          void refresh();
        }, (requestError) => {
          setError(requestError?.message || t("failed"));
        });
      };

      const answerPrompt = async (decline) => {
        const prompt = attempt?.state?.prompt;
        if (!attempt || !prompt || promptBusy) return;
        setPromptBusy(true);
        setError("");
        try {
          const state = decline
            ? await api.decline(attempt.attemptId, prompt.id)
            : await api.answer(attempt.attemptId, prompt.id, answer);
          setAttempt((current) => current?.attemptId === attempt.attemptId
            ? { ...current, state }
            : current);
        } catch (requestError) {
          setError(requestError?.message || t("failed"));
        } finally {
          setPromptBusy(false);
        }
      };

      const renderButton = (label, action, primary, disabled, actionId) => h("button", {
        ...(actionId ? { "data-authorization-action": actionId } : {}),
        disabled,
        onClick: action,
        style: { ...(primary ? styles.primaryButton : styles.button), opacity: disabled ? 0.55 : 1 },
        type: "button",
      }, label);

      const renderAttempt = (entry) => {
        if (attempt?.key !== entry.key) return null;
        const state = attempt.state;
        const prompt = state?.prompt;
        return h("div", { style: styles.attempt, "data-authorization-attempt": attempt.attemptId },
          ...(state?.notices || []).map((notice, index) => h("div", { key: `${state.revision}-${index}` },
            h("p", { style: styles.notice }, notice.message),
            notice.url ? h("a", {
              href: notice.url,
              rel: "noreferrer noopener",
              style: styles.link,
              target: "_blank",
            }, t("openPage")) : null,
            notice.code ? h("div", null,
              h("span", { style: styles.status }, `${t("code")}: `),
              h("code", { style: styles.code }, notice.code),
            ) : null,
          )),
          !state ? h("p", { style: styles.status }, t("busy")) : null,
          prompt ? h("div", { style: styles.prompt, "data-authorization-prompt": prompt.kind },
            h("label", null, prompt.message),
            prompt.kind === "select"
              ? h("select", {
                  disabled: promptBusy,
                  onChange: (event) => setAnswer(event.currentTarget.value),
                  style: styles.input,
                  value: answer,
                },
                h("option", { value: "" }, "—"),
                ...prompt.options.map((option) => h("option", { key: option.id, value: option.id }, option.label)),
              )
              : h("input", {
                  autoComplete: "off",
                  disabled: promptBusy,
                  onChange: (event) => setAnswer(event.currentTarget.value),
                  placeholder: prompt.placeholder,
                  style: styles.input,
                  type: prompt.kind === "secret" ? "password" : "text",
                  value: answer,
                }),
            h("div", { style: styles.actions },
              renderButton(t("decline"), () => void answerPrompt(true), false, promptBusy, "decline"),
              renderButton(t("submit"), () => void answerPrompt(false), true, promptBusy || !answer, "answer"),
            ),
          ) : null,
        );
      };

      return h("section", { style: styles.section, "data-workbench-authorization": true },
        h("header", { style: styles.heading },
          h("h2", { style: styles.title }, t("title")),
          h("p", { style: styles.description }, t("description")),
        ),
        error ? h("p", { role: "alert", style: styles.error }, error, " ",
          h("button", { onClick: () => void refresh(), style: styles.button, type: "button" }, t("retry")),
        ) : null,
        snapshot === null && !error ? h("p", { style: styles.status }, t("loading")) : null,
        snapshot?.entries.length === 0 ? h("p", { style: styles.status }, t("empty")) : null,
        snapshot ? h("ul", { style: styles.list }, snapshot.entries.map((entry) => {
          const localBusy = busyKey === entry.key || attempt?.key === entry.key;
          const busy = localBusy || entry.inFlight;
          return h("li", { key: entry.key, style: styles.row, "data-authorization-key": entry.key },
            h("div", { style: styles.rowHead },
              h("div", { style: styles.identity },
                h("div", { style: styles.nameLine },
                  h("strong", { style: styles.name }, entry.label),
                  h("span", { style: styles.badge }, entry.configured ? t("configured") : t("unconfigured")),
                  entry.inFlight ? h("span", { style: styles.badge }, t("busy")) : null,
                  entry.orphan ? h("span", { style: styles.badge }, t("orphan")) : null,
                  entry.kind ? h("span", { style: styles.badge }, t(entry.kind === "grant" ? "grant" : "apiKey")) : null,
                ),
                h("code", { style: styles.key }, entry.key),
              ),
              h("div", { style: styles.actions },
                ...entry.methods.map((method) => renderButton(
                  method.label,
                  () => start(entry, method),
                  !entry.configured,
                  busy,
                  `begin-${method.id}`,
                )),
                entry.inFlight || localBusy
                  ? renderButton(t("cancel"), () => cancel(entry), false, false, "cancel")
                  : null,
                entry.configured
                  ? renderButton(
                      t("signOut"),
                      () => void run(entry, () => api.delete(entry.key)),
                      false,
                      busy || !entry.writable,
                      "delete",
                    )
                  : null,
              ),
            ),
            renderAttempt(entry),
          );
        })) : null,
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "oauth-ui: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-workbench-authorization",
        order: 6,
        label: () => t("nav"),
        inject: () => ({ t }),
      }, AuthorizationSection));
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
