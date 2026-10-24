import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { whatsappOutboundBase } from "./outbound-base.js";
import { normalizeWhatsAppPayloadTextPreservingIndentation } from "./outbound-media-contract.js";

const loadWhatsAppApprovalReactionsModule = createLazyRuntimeModule(
  () => import("./approval-reactions.js"),
);

async function prepareWhatsAppApprovalPayloadForDelivery(
  params: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0],
) {
  return (await loadWhatsAppApprovalReactionsModule()).prepareWhatsAppApprovalPayloadForDelivery({
    payload: params.payload,
    presentation: params.presentation,
  });
}

async function registerDeliveredWhatsAppApprovalPayload(
  params: Parameters<NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]>>[0],
): Promise<void> {
  await (
    await loadWhatsAppApprovalReactionsModule()
  ).registerWhatsAppApprovalReactionTargetForDeliveredPayload(params);
}

export const whatsappChannelOutbound = {
  ...whatsappOutboundBase,
  sendTextOnlyErrorPayloads: true,
  renderPresentation: prepareWhatsAppApprovalPayloadForDelivery,
  afterDeliverPayload: registerDeliveredWhatsAppApprovalPayload,
  normalizePayload: ({ payload }: { payload: { text?: string } }) => ({
    ...payload,
    text: normalizeWhatsAppPayloadTextPreservingIndentation(payload.text),
  }),
};

function toWhatsAppMessageSendResult(
  result:
    | Awaited<ReturnType<NonNullable<typeof whatsappChannelOutbound.sendText>>>
    | Awaited<ReturnType<NonNullable<typeof whatsappChannelOutbound.sendMedia>>>,
  replyToId?: string | null,
): ChannelMessageSendResult {
  // Deliberately omit the transport's toJid: on LID-enabled accounts it is the
  // recipient's LID alias, and carrying it in the result (or the receipt raw)
  // makes source-reply target matching compare an alias against the requested
  // phone-number identity (gh-182297).
  const receipt =
    result.receipt ??
    createMessageReceiptFromOutboundResults({
      results: result.messageId ? [{ channel: "whatsapp", messageId: result.messageId }] : [],
      kind: "text",
      ...(replyToId ? { replyToId } : {}),
    });
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
  };
}

export const whatsappMessageAdapter = defineChannelMessageAdapter({
  id: "whatsapp",
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async ({ onDeliveryResult, ...ctx }) => {
      const result = await whatsappChannelOutbound.sendText!({
        ...ctx,
        onDeliveryResult: onDeliveryResult
          ? async (progress) => {
              await onDeliveryResult(toWhatsAppMessageSendResult(progress, ctx.replyToId));
            }
          : undefined,
      });
      return toWhatsAppMessageSendResult(result, ctx.replyToId);
    },
    media: async ({ onDeliveryResult, ...ctx }) => {
      // Route media through the same sanitized result shape as text. The legacy
      // bridge forwards the transport's toJid (the recipient's LID alias on
      // LID-enabled accounts), which then fails source-reply target matching and
      // turns a delivered media send into a false "empty response" failure.
      const result = await whatsappChannelOutbound.sendMedia!({
        ...ctx,
        onDeliveryResult: onDeliveryResult
          ? async (progress) => {
              await onDeliveryResult(toWhatsAppMessageSendResult(progress, ctx.replyToId));
            }
          : undefined,
      });
      return toWhatsAppMessageSendResult(result, ctx.replyToId);
    },
  },
});
