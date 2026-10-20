import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enApprovalPrompts = {
  execApproval: {
    watcherApprovalScope:
      "Approval applies to this saved watcher. Source changes or reactivation may require approval again.",
    watcherSandboxSummary:
      "Runs in your sandbox after you leave this chat, until stopped. Restarts automatically after interruptions.",
    watcherGatewaySummary:
      "Runs on the Gateway after you leave this chat, until stopped. Restarts automatically after interruptions.",
    watcherSummary:
      "Runs after you leave this chat, until stopped. Restarts automatically after interruptions.",
    startWatcher: "Start watching",
    saveWatcher: "Save watcher change",
    cancelWatcher: "Cancel",

    scope: {
      standingGrant:
        'Always allow runs this exact command for "{automation}" without asking, until revoked (revocable)',
      standingGrantDays:
        'Always allow runs this exact command for "{automation}" without asking, for {count} days (revocable)',
      messageSend: "Sends to {count} recipient(s) via {target}",
      payment: "Pays {amount} {currency} to {target}",
      externalPost: "Posts externally to {target}",
    },
    expiresIn: "expires in {time}",
    expired: "expired",
    execApprovalNeeded: "Exec approval needed",
    pluginApprovalNeeded: "Plugin approval needed",
    requestedBySession: "Approval requested by session {session}",
    pending: "{count} pending",
    otherPending: "Other pending requests",
    reviewRequest: "Review approval from {agent}: {command}",
    decisionRequest: "{decision}: {command}",
    agentPendingOne: "{count} pending approval",
    agentPending: "{count} pending approvals",
    allowOnce: "Allow once",
    alwaysAllow: "Always allow",
    alwaysAllowHere: "Always allow here",
    allowAlwaysUnavailable: "Allow Always is unavailable for this command.",
    reviewOnly: "Review only. Sign in with approval access to record a decision.",
    deny: "Deny",
    details: "Details",
    labels: {
      host: "Host",
      session: "Session",
      cwd: "CWD",
      resolved: "Resolved",
      security: "Security",
      ask: "Ask",
    },
  },

  approvalPage: {
    brandName: "OpenClaw",
    eyebrow: "Operator approval",
    loadingTitle: "Loading approval",
    loadingDescription: "Checking the current approval state with the Gateway.",
    unavailableTitle: "Approval unavailable",
    unavailableDescription:
      "This approval could not be found or this device is not authorized to review it.",
    connectionErrorTitle: "Connection interrupted",
    connectionErrorDescription:
      "OpenClaw cannot confirm or record a decision while disconnected. Reconnect to check the current status.",
    retry: "Retry",
    execTitle: "Command approval",
    watcherTitle: "Watcher approval: {name}",
    watcherChangeTitle: "Watcher change: {name}",
    watcherLifetime:
      "If saved and enabled, this watcher runs after you leave this chat, until stopped. It is configured to restart automatically after interruptions.",
    watcherAllowed:
      "This proposal was approved. Approval alone does not confirm that the change was saved or the watcher started. Check its current status in Automations.",
    watcherNotCreated: "This proposal did not create a watcher.",
    watcherNotChanged:
      "This proposal did not save the change. It did not stop or change the existing watcher.",
    pending: "Waiting for your decision",
    pendingDescription: "Review the request carefully. The first answer from any surface wins.",
    approvedHere: "Approved here",
    deniedHere: "Denied here",
    resolvedElsewhere: "Resolved elsewhere",
    resolvedElsewhereDescription:
      "Another surface or an earlier attempt recorded the decision first.",
    approved: "Approved",
    denied: "Denied",
    expired: "Expired",
    cancelled: "Cancelled",
    allowedOnceDescription: "The operation was approved for this request only.",
    allowedAlwaysDescription: "The operation was approved with the always-allow decision.",
    deniedDescription: "The operation was denied and will not continue.",
    expiredDescription: "No decision arrived before the deadline, so the operation was denied.",
    cancelledDescription: "This approval request was canceled and can no longer be used.",
    summaryLabel: "Summary",
    commandLabel: "Command",
    requestLabel: "Request details",
    nodeLabel: "Node",
    expiresLabel: "Expires",
    resolvedLabel: "Resolved",
    actionsLabel: "Approval decisions",
    resolvingDecision: "Recording {decision}…",
    safeToClose: "The decision is recorded. You can close this page.",
    openControlUi: "Open Control UI",
  },
} satisfies TranslationMap;

export const registerApprovalPromptsEnglish = Object.assign(
  () => {
    Object.assign(en.approvalPage, enApprovalPrompts.approvalPage);
    Object.assign(en.execApproval, enApprovalPrompts.execApproval);
  },
  { catalog: enApprovalPrompts },
);
