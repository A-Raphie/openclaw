import { createMemo, createSignal, Show } from "solid-js";
import type { PluginInlineViewBlock } from "../../../src/shared/plugin-inline-view.js";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createIntersectionObserver, createResizeObserver } from "../lib/reactive/observers.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { CustomPluginUiDisabled } from "./control-ui-disabled.solid.tsx";
import { PluginContribution } from "./control-ui-view.solid.tsx";

/** Rows own only a small placeholder offscreen, never a parked plugin/component cache. */
export function PluginInlineView(props: {
  block: PluginInlineViewBlock;
  sessionKey: string;
  agentId?: string;
  presented?: boolean;
}) {
  const app = useOptionalApplication();
  const runtime = projectSource(app?.plugins, {
    read: (source) => source,
    subscribe: (source, publish) => source?.subscribe(publish) ?? (() => {}),
    equality: "revision",
  });
  const [near, setNear] = createSignal(false);
  const [height, setHeight] = createSignal(160);
  let root!: HTMLDivElement;
  createIntersectionObserver(
    () => [root],
    ([entry]) => setNear(entry?.isIntersecting === true),
    { rootMargin: "400px 0px" },
  );
  createResizeObserver(
    () => [root],
    ([entry]) => {
      if (near() && props.presented !== false && entry && entry.contentRect.height > 0) {
        setHeight(entry.contentRect.height);
      }
    },
  );
  const key = () => props.block.pluginId + "/" + props.block.viewId + "@" + props.block.version;
  const status = createMemo(() => {
    const owner = runtime.read();
    if (owner?.isLoading(props.block.pluginId)) {
      return "loading";
    }
    return owner?.registrations("inlineViews").some((entry) => entry.key === key())
      ? "ok"
      : "unavailable";
  });
  const notice = () => (
    <div class="card" role="status">
      <strong>{runtime.read()?.inlineViewLabel(key()) ?? props.block.viewId}</strong>
      <p class="muted">
        {t(status() === "loading" ? "pluginUi.inlineLoading" : "pluginUi.inlineUnavailable")}
      </p>
      <CustomPluginUiDisabled context={app} pluginId={props.block.pluginId} />
    </div>
  );
  return (
    <div
      class="chat-plugin-inline-view"
      data-plugin-inline-view={props.block.toolCallId}
      ref={(element) => {
        root = element;
      }}
      style={{ "min-height": near() && props.presented !== false ? undefined : height() + "px" }}
    >
      <Show when={near() && props.presented !== false}>
        <Show when={status() === "ok"} fallback={notice()}>
          <PluginContribution
            kind="inlineViews"
            contributionKey={key()}
            props={{
              payload: props.block.payload,
              toolCallId: props.block.toolCallId,
              toolName: props.block.toolName,
              sessionKey: props.sessionKey,
              agentId: props.agentId,
            }}
            fallback={notice}
          />
        </Show>
      </Show>
    </div>
  );
}
