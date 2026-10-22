import { Show } from "solid-js";
import { SESSION_VISIBILITY_VALUES } from "../../../../../packages/gateway-protocol/src/schema/sessions-sharing-constants.js";
import type { SessionMemberPermissionLevel } from "../../../../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult,
  SessionVisibility,
} from "../../../api/types.ts";
import type { PersonActivityRouting } from "../../../components/person-activity-link.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerSessionPeopleEnglish } from "../../../i18n/locales/en-session-people.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerSessionPeopleEnglish);

export type ChatSessionSharingOutcome =
  | { status: "success" }
  | { status: "unchanged" | "unavailable" | "cancelled" | "stale" }
  | { status: "failed"; error: string };

// Legacy parents may still discard the result; only confirmed success closes a surface.
export type ChatSessionSharingAction =
  | void
  | ChatSessionSharingOutcome
  | Promise<void | ChatSessionSharingOutcome>;

export type ChatSessionSharingState = {
  loading: boolean;
  result?: SessionMembersListEvidenceResult;
  publicUrl?: string;
  error?: string;
};

export type ChatSessionSharingProps = {
  session: GatewaySessionRow | undefined;
  state: ChatSessionSharingState | undefined;
  allowedVisibilities?: readonly SessionVisibility[];
  membersAvailable?: boolean;
  openDisabledReason?: string;
  visibilityDisabledReason?: string;
  memberAddDisabledReason?: string;
  memberRemoveDisabledReason?: string;
  publicShareDisabledReason?: string;
  onPublicShareChange?: (enabled: boolean) => ChatSessionSharingAction;
  onCopyPublicLink?: () => ChatSessionSharingAction;
  ownerViewing?: boolean;
  personActivity?: PersonActivityRouting;
  showOwner?: boolean;
  onOpen: () => void;
  onVisibilityChange: (visibility: SessionVisibility) => ChatSessionSharingAction;
  onMemberChange: (identityId: string, member: boolean) => ChatSessionSharingAction;
};

export type PreparedChatSessionSharing = Omit<
  ChatSessionSharingProps,
  "session" | "onVisibilityChange" | "onMemberChange" | "onPublicShareChange" | "onCopyPublicLink"
> & {
  session: GatewaySessionRow;
  onVisibilityChange: (visibility: SessionVisibility) => Promise<ChatSessionSharingOutcome>;
  onMemberChange: (identityId: string, member: boolean) => Promise<ChatSessionSharingOutcome>;
  onPublicShareChange: (enabled: boolean) => Promise<ChatSessionSharingOutcome>;
  onCopyPublicLink: () => Promise<ChatSessionSharingOutcome>;
};

export const VISIBILITY_LABEL_KEYS: Record<SessionVisibility, string> = {
  shared: "chat.sessionSharing.shared",
  "read-only": "chat.sessionSharing.readOnly",
  suggest: "chat.sessionSharing.suggest",
  draft: "chat.sessionSharing.draft",
};

export function selectChatSessionSharingItem(
  props: ChatSessionSharingProps,
  value: string | undefined,
): ChatSessionSharingAction {
  if (!props.session || !canManageChatSessionSharing(props.session) || props.state?.loading) {
    return { status: "unavailable" };
  }
  if (value?.startsWith("public:")) {
    if (!props.state?.result) {
      return { status: "unavailable" };
    }
    if (value === "public:copy" && props.state.result.publicShare) {
      return props.onCopyPublicLink?.();
    } else if (
      !props.publicShareDisabledReason &&
      (value === "public:enable" || value === "public:disable")
    ) {
      return props.onPublicShareChange?.(value === "public:enable");
    }
    return;
  }
  if (value?.startsWith("visibility:")) {
    const visibility = SESSION_VISIBILITY_VALUES.find((option) => value === `visibility:${option}`);
    if (
      visibility &&
      (
        props.state?.result?.allowedVisibilities ??
        props.allowedVisibilities ?? [props.session.visibility ?? "shared"]
      ).includes(visibility) &&
      !props.visibilityDisabledReason &&
      visibility !== (props.session?.visibility ?? "shared")
    ) {
      return props.onVisibilityChange(visibility);
    }
    return;
  }
  if (!value?.startsWith("permission:")) {
    return;
  }
  if (props.session.visibility !== "read-only" && props.session.visibility !== "suggest") {
    return { status: "unavailable" };
  }
  const separator = value.indexOf(":", "permission:".length);
  const level = value.slice("permission:".length, separator);
  const identityId = value.slice(separator + 1);
  const permission = props.state?.result?.permissions?.find((row) => row.identityId === identityId);
  if (
    !permission ||
    permission.level === level ||
    !permission.options.some((option) => option === level)
  ) {
    return { status: "unavailable" };
  }
  const member = level === "send";
  const reason = member ? props.memberAddDisabledReason : props.memberRemoveDisabledReason;
  if (!reason) {
    return props.onMemberChange(identityId, member);
  }
}

export function canManageChatSessionSharing(
  session: Pick<GatewaySessionRow, "sharingRole">,
): boolean {
  return session.sharingRole === "admin" || session.sharingRole === "owner";
}

export function ChatSessionSharingModeIcon(props: {
  visibility: SessionVisibility;
  external?: boolean;
}) {
  return (
    <Icon
      class={props.visibility === "draft" ? "chat-pane__sharing-draft-glyph" : undefined}
      name={
        props.visibility === "draft"
          ? "messageCircle"
          : props.visibility === "shared"
            ? "users"
            : props.visibility === "suggest"
              ? "messageSquarePlus"
              : props.external
                ? "eye"
                : "messageSquare"
      }
    />
  );
}

export function ChatSessionPublicIndicator(
  props: Pick<ChatSessionSharingProps, "state"> & { mobile?: boolean },
) {
  return (
    <Show when={props.state?.result?.publicShare}>
      <span
        class={[
          "chat-pane__public-share-indicator",
          { "chat-pane__public-share-indicator--mobile": props.mobile },
        ]}
        role="status"
        aria-label={t("chat.sessionSharing.worldReadable")}
        title={t("chat.sessionSharing.worldReadable")}
      >
        <Show when={!props.mobile}>
          <span aria-hidden="true">
            <Icon name="globe" />
          </span>
        </Show>
        <span>{t("chat.sessionSharing.publicIndicator")}</span>
      </span>
    </Show>
  );
}

export const CHAT_SESSION_SHARING_DESCRIPTION_KEYS: Record<SessionVisibility, string> = {
  shared: "chat.sessionSharing.sharedDescription",
  "read-only": "chat.sessionSharing.readOnlyDescription",
  suggest: "chat.sessionSharing.suggestDescription",
  draft: "chat.sessionSharing.draftDescription",
};

export function chatSessionPermissionLabel(level: SessionMemberPermissionLevel) {
  return t(
    level === "send"
      ? "chat.sessionSharing.canSend"
      : level === "suggest"
        ? "chat.sessionSharing.canSuggest"
        : "chat.sessionSharing.canRead",
  );
}

export type ChatSessionSharingRosterRow = {
  identity: NonNullable<SessionMembersListEvidenceResult["owner"]>;
  owner: boolean;
  fixed: boolean;
  level?: SessionMemberPermissionLevel;
  options: readonly SessionMemberPermissionLevel[];
  controlLabel: string;
  disabledReason?: string;
};

export function projectChatSessionSharingRoster(
  input: ChatSessionSharingProps,
): ChatSessionSharingRosterRow[] {
  const result = input.state?.result;
  const identities = new Map(result?.identities.map((identity) => [identity.id, identity]));
  const rows: ChatSessionSharingRosterRow[] = (result?.permissions ?? [])
    .flatMap((permission) => {
      const identity = identities.get(permission.identityId);
      return identity && identity.id !== result?.owner?.id
        ? [
            {
              identity,
              owner: false,
              fixed: permission.options.length < 2,
              level: permission.level,
              options: permission.options,
              controlLabel: chatSessionPermissionLabel(permission.level),
              disabledReason: input.state?.loading
                ? t("common.loading")
                : permission.level === "send"
                  ? input.memberRemoveDisabledReason
                  : input.memberAddDisabledReason,
            },
          ]
        : [];
    })
    .toSorted((a, b) =>
      (a.identity.label ?? a.identity.id).localeCompare(b.identity.label ?? b.identity.id),
    );
  return result?.owner
    ? [
        {
          identity: result.owner,
          owner: true,
          fixed: true,
          options: [],
          controlLabel: t("chat.sessionSharing.owner"),
        },
        ...rows,
      ]
    : rows;
}
