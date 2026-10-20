import { For, Show } from "solid-js";
import type { CyberAccessProgram } from "../../../api/types.ts";
import { isCyberAccessProgram } from "../../../lib/chat/cyber-access-program.ts";
import { t } from "../../../lib/reactive/i18n.ts";

const programLabels = {
  standard: "chat.modelControls.standard",
  daybreak_blue: "chat.modelControls.daybreakBlue",
  daybreak_red: "chat.modelControls.daybreakRed",
} as const;

export type ChatAccessProgramControlProps = {
  programs: readonly CyberAccessProgram[];
  requested?: CyberAccessProgram;
  disabled: boolean;
  sessionKey: string;
  onSelect: (value: CyberAccessProgram | null, sessionKey: string) => unknown;
};

export function ChatAccessProgramControl(props: ChatAccessProgramControlProps) {
  const hasDaybreak = () => props.programs.some((program) => program !== "standard");
  return (
    <Show when={hasDaybreak()}>
      <div class="chat-controls__access-panel">
        <label class="chat-controls__access-label">
          <span class="chat-controls__effort-heading">{t("chat.modelControls.access")}</span>
          <select
            class="chat-controls__access-select"
            data-chat-access-program
            aria-label={t("chat.modelControls.access")}
            // An unavailable saved value must not masquerade as an already-selected reset.
            value={props.requested ?? ""}
            disabled={props.disabled}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (
                !props.disabled &&
                (value === "" || (isCyberAccessProgram(value) && props.programs.includes(value)))
              ) {
                void props.onSelect(value || null, props.sessionKey);
              }
            }}
          >
            <option value="">{t("chat.modelControls.accessDefault")}</option>
            <For each={props.programs}>
              {(program) => <option value={program}>{t(programLabels[program])}</option>}
            </For>
          </select>
        </label>
      </div>
    </Show>
  );
}
