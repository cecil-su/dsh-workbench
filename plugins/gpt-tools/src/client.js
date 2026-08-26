window.__ModuleLoader__.load({
  id: "@dsh-workbench/gpt-tools",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const inject = ["slots", "conversation"];

    const styles = {
      root: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        margin: "4px 0 6px 4px",
        maxWidth: "320px",
      },
      header: {
        alignItems: "center",
        color: "var(--dsw-alias-label-secondary)",
        display: "flex",
        fontSize: "14px",
        gap: "8px",
        lineHeight: "24px",
      },
      status: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "12px",
      },
      inspect: {
        background: "transparent",
        border: 0,
        color: "var(--dsw-alias-label-tertiary)",
        cursor: "pointer",
        font: "inherit",
        marginLeft: "auto",
        padding: 0,
      },
      thumbnailButton: {
        background: "var(--dsw-alias-interactive-bg-hover)",
        border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
        borderRadius: "14px",
        cursor: "zoom-in",
        display: "block",
        lineHeight: 0,
        maxWidth: "240px",
        overflow: "hidden",
        padding: 0,
      },
      thumbnail: {
        display: "block",
        height: "auto",
        maxHeight: "240px",
        maxWidth: "240px",
        objectFit: "contain",
        width: "auto",
      },
      error: {
        color: "var(--dsw-alias-state-error-primary)",
        fontSize: "12px",
        lineHeight: "18px",
      },
      backdrop: {
        background: "var(--dsw-alias-bg-mask-1)",
        border: 0,
        cursor: "zoom-out",
        inset: 0,
        padding: "40px",
        position: "fixed",
        zIndex: 1000,
      },
      original: {
        background: "var(--dsw-specific-input-major)",
        borderRadius: "12px",
        boxShadow: "var(--dsw-shadow-lv3)",
        height: "100%",
        objectFit: "contain",
        width: "100%",
      },
      close: {
        alignItems: "center",
        background: "var(--dsw-specific-input-major)",
        border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
        borderRadius: "999px",
        color: "var(--dsw-alias-label-primary)",
        cursor: "pointer",
        display: "flex",
        fontSize: "22px",
        height: "36px",
        justifyContent: "center",
        position: "fixed",
        right: "20px",
        top: "20px",
        width: "36px",
        zIndex: 1001,
      },
    };

    function resultImage(block) {
      if (block?.kind !== "tool-result" || block.isError || !Array.isArray(block.content)) return null;
      const image = block.content.find((part) => part?.type === "image");
      const attachment = image?.attachment;
      return attachment && typeof attachment.attachmentId === "string" ? attachment : null;
    }

    function resultError(block) {
      if (block?.kind !== "tool-result" || !block.isError || !Array.isArray(block.content)) return null;
      const text = block.content.find((part) => part?.type === "text" && typeof part.text === "string");
      return text?.text || "Image generation failed.";
    }

    function GenerateImageToolView({ block, inspect, loadImage }) {
      const attachment = resultImage(block);
      const attachmentKey = attachment?.attachmentId || null;
      const [loaded, setLoaded] = React.useState({ key: null, state: "idle" });
      const [previewOpen, setPreviewOpen] = React.useState(false);

      React.useEffect(() => {
        setPreviewOpen(false);
        if (attachment === null) {
          setLoaded({ key: null, state: "idle" });
          return undefined;
        }
        let active = true;
        setLoaded({ key: attachmentKey, state: "loading" });
        Promise.resolve(loadImage(attachment)).then(
          (url) => {
            if (active) setLoaded({ key: attachmentKey, state: "ready", url });
          },
          (error) => {
            if (active) setLoaded({
              key: attachmentKey,
              state: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          },
        );
        return () => { active = false; };
      }, [attachmentKey]);

      const current = loaded.key === attachmentKey ? loaded : { key: attachmentKey, state: "loading" };
      const error = resultError(block);
      const settled = block?.kind === "tool-result";
      const title = error ? "Image generation failed" : settled ? "Generated image" : "Generating image";

      return h("div", { style: styles.root, "data-gpt-image-preview": settled ? "settled" : "running" },
        h("div", { style: styles.header },
          h("span", null, title),
          !settled ? h("span", { style: styles.status }, "…") : null,
          inspect ? h("button", {
            type: "button",
            style: styles.inspect,
            onClick: inspect,
            "aria-label": "Inspect image generation",
          }, "Details") : null,
        ),
        error ? h("div", { style: styles.error }, error) : null,
        attachment && current.state === "loading"
          ? h("div", { style: styles.status }, "Loading image preview…")
          : null,
        attachment && current.state === "error"
          ? h("div", { style: styles.error }, `Could not load image preview: ${current.message}`)
          : null,
        attachment && current.state === "ready"
          ? h("button", {
              type: "button",
              style: styles.thumbnailButton,
              onClick: () => setPreviewOpen(true),
              "aria-label": "Open generated image preview",
            }, h("img", {
              src: current.url,
              alt: attachment.name || "Generated image",
              style: styles.thumbnail,
            }))
          : null,
        attachment && current.state === "ready" && previewOpen
          ? h(React.Fragment, null,
              h("button", {
                type: "button",
                style: styles.backdrop,
                onClick: () => setPreviewOpen(false),
                "aria-label": "Close generated image preview",
              }, h("img", {
                src: current.url,
                alt: attachment.name || "Generated image",
                style: styles.original,
              })),
              h("button", {
                type: "button",
                style: styles.close,
                onClick: () => setPreviewOpen(false),
                "aria-label": "Close generated image preview",
              }, "×"),
            )
          : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
        name: "tool.call.toolview",
        key: "generate_image",
        inject: (sessionId) => ({
          loadImage: (attachment) => ctx.conversation.resolveImage(sessionId, attachment),
        }),
      }, GenerateImageToolView));
    }

    exports.GenerateImageToolView = GenerateImageToolView;
    exports.apply = apply;
    exports.inject = inject;
    exports.resultImage = resultImage;
    return module.exports;
  },
});
