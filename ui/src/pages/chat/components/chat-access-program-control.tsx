import { For, onCleanup } from "solid-js";
import type { CyberAccessProgram } from "../../../api/types.ts";
import { t } from "../../../lib/reactive/i18n.ts";

const programs = ["standard", "daybreak_blue", "daybreak_red"] as const;
const programLabels = {
  standard: "chat.modelControls.standard",
  daybreak_blue: "chat.modelControls.accessBlue",
  daybreak_red: "chat.modelControls.accessRed",
} as const;

export type ChatAccessProgramControlProps = {
  requested?: CyberAccessProgram;
  reported?: CyberAccessProgram;
  disabled: boolean;
  sessionKey: string;
  onSelect: (value: CyberAccessProgram | null, sessionKey: string) => unknown;
};

export function ChatAccessProgramControl(props: ChatAccessProgramControlProps) {
  const buttons = new Map<CyberAccessProgram, HTMLButtonElement>();
  return (
    <div class="chat-controls__access-panel">
      <div class="chat-controls__reasoning-head">
        <span class="chat-controls__effort-heading">{t("chat.modelControls.accessRequested")}</span>
        <button
          class="chat-controls__access-reset"
          data-chat-access-reset
          type="button"
          disabled={props.disabled || props.requested === undefined}
          onClick={() => {
            void props.onSelect(null, props.sessionKey);
          }}
        >
          {t("chat.modelControls.accessReset")}
        </button>
      </div>
      <div
        class="chat-controls__speed-options"
        role="radiogroup"
        aria-label={t("chat.modelControls.accessRequested")}
        data-chat-access-program
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || props.disabled) {
            return;
          }
          const enabled = programs;
          const current = enabled.indexOf(props.requested ?? "standard");
          const next =
            event.key === "Home"
              ? enabled[0]
              : event.key === "End"
                ? enabled.at(-1)
                : enabled[
                    (current + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) %
                      enabled.length
                  ];
          if (next) {
            event.preventDefault();
            buttons.get(next)?.focus();
            void props.onSelect(next, props.sessionKey);
          }
        }}
      >
        <For each={programs}>
          {(program) => {
            onCleanup(() => buttons.delete(program));
            return (
              <button
                ref={(element) => {
                  buttons.set(program, element);
                }}
                type="button"
                role="radio"
                class="chat-controls__speed-option"
                data-chat-access-option={program}
                aria-checked={props.requested === program ? "true" : "false"}
                tabindex={
                  props.requested === program ||
                  (props.requested === undefined && program === "standard")
                    ? 0
                    : -1
                }
                disabled={props.disabled}
                onClick={() => {
                  if (!props.disabled) {
                    void props.onSelect(program, props.sessionKey);
                  }
                }}
              >
                {t(programLabels[program])}
              </button>
            );
          }}
        </For>
      </div>
      {props.requested === undefined && (
        <p class="chat-controls__access-note">{t("chat.modelControls.accessDefault")}</p>
      )}
      <p class="chat-controls__access-note" data-chat-access-reported aria-live="polite">
        {t("chat.modelControls.accessReported", {
          value: props.reported
            ? t(programLabels[props.reported])
            : t("chat.modelControls.accessUnverified"),
        })}
      </p>
      <p class="chat-controls__access-note">{t("chat.modelControls.accessHelp")}</p>
    </div>
  );
}
