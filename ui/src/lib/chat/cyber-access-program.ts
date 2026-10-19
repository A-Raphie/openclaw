import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { CyberAccessProgram } from "../../api/types.ts";
import { buildQualifiedChatModelValue, normalizeChatModelProviderId } from "./model-ref.ts";

export function isCyberAccessProgram(value: unknown): value is CyberAccessProgram {
  return value === "standard" || value === "daybreak_blue" || value === "daybreak_red";
}

/** Read only provider response metadata from the latest matching assistant message. */
export function readResponseAccessProgram(
  messages: readonly unknown[],
  selectedModel: string,
): CyberAccessProgram | undefined {
  if (!selectedModel) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = asOptionalRecord(messages[index]);
    if (
      message?.role !== "assistant" ||
      typeof message.model !== "string" ||
      typeof message.provider !== "string"
    ) {
      continue;
    }
    const model = buildQualifiedChatModelValue(
      message.model,
      normalizeChatModelProviderId(message.provider),
    );
    if (model.toLowerCase() === selectedModel.toLowerCase()) {
      // An unreported latest response must not borrow a previous response's evidence.
      return isCyberAccessProgram(message.responseAccessProgram)
        ? message.responseAccessProgram
        : undefined;
    }
  }
  return undefined;
}
