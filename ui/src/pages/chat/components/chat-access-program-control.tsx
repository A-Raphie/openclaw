import type { CyberAccessProgram } from "../../../api/types.ts";
import { isCyberAccessProgram } from "../../../lib/chat/cyber-access-program.ts";
import { t } from "../../../lib/reactive/i18n.ts";

const programLabels = {
  standard: "chat.modelControls.standard",
  daybreak_blue: "chat.modelControls.daybreakBlue",
  daybreak_red: "chat.modelControls.daybreakRed",
} as const;

export type ChatAccessProgramControlProps = {
  requested?: CyberAccessProgram;
  reported?: CyberAccessProgram;
  disabled: boolean;
  sessionKey: string;
  onSelect: (value: CyberAccessProgram | null, sessionKey: string) => unknown;
};

export function ChatAccessProgramControl(props: ChatAccessProgramControlProps) {
  return (
    <div class="chat-controls__access-panel">
      <label class="chat-controls__access-label">
        <span class="chat-controls__effort-heading">{t("chat.modelControls.accessRequested")}</span>
        <select
          class="chat-controls__access-select"
          data-chat-access-program
          aria-label={t("chat.modelControls.accessRequested")}
          value={props.requested ?? ""}
          disabled={props.disabled}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (!props.disabled && (value === "" || isCyberAccessProgram(value))) {
              void props.onSelect(value || null, props.sessionKey);
            }
          }}
        >
          <option value="">{t("chat.modelControls.accessDefault")}</option>
          <option value="standard">{t(programLabels.standard)}</option>
          <option value="daybreak_blue">{t(programLabels.daybreak_blue)}</option>
          <option value="daybreak_red">{t(programLabels.daybreak_red)}</option>
        </select>
      </label>
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
