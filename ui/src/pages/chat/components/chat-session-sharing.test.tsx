import { createSignal, flush } from "solid-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSessionSharing, type ChatSessionSharingProps } from "./chat-session-sharing.solid.tsx";

function renderSharing(props: Partial<ChatSessionSharingProps>) {
  return {
    session: sharingSession({}),
    state: undefined,
    onOpen: vi.fn(),
    onVisibilityChange: vi.fn(),
    onMemberChange: vi.fn(),
    ...props,
  } satisfies ChatSessionSharingProps;
}

type SharingResult = NonNullable<NonNullable<ChatSessionSharingProps["state"]>["result"]>;
function sharingState(result: Partial<SharingResult> = {}, loading = false) {
  return {
    loading,
    result: {
      sessionKey: "agent:main:main",
      members: [],
      identities: [],
      permissions: [],
      role: "owner",
      allowedVisibilities: ["shared"],
      ...result,
    } satisfies SharingResult,
  };
}
const publicShare = { token: `v1.${"a".repeat(96)}`, createdAt: 1 };
const owner = {
  type: "human",
  id: "owner",
  identity: { type: "profile", id: "owner" },
  label: "Owner",
} as const;
function human(id: string, label: string) {
  return { type: "human" as const, id, label };
}

function sharingSession(overrides: Partial<NonNullable<ChatSessionSharingProps["session"]>>) {
  return {
    key: "agent:main:main",
    kind: "direct" as const,
    updatedAt: 1,
    visibility: "shared" as const,
    sharingRole: "owner" as const,
    ...overrides,
  };
}

let container: HTMLDivElement | undefined;

// JSDOM has no visibility API; browser menu tests cover layout and hidden controls.
beforeAll(() => {
  Object.defineProperty(Element.prototype, "checkVisibility", {
    configurable: true,
    value: () => true,
  });
});

afterAll(() => {
  Reflect.deleteProperty(Element.prototype, "checkVisibility");
});

afterEach(() => {
  container?.remove();
  container = undefined;
});

const updates = new WeakMap<HTMLElement, (props: ChatSessionSharingProps) => void>();
const part = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`.chat-pane__${name}`);
const item = (root: HTMLElement, value: string) =>
  root.querySelector<HTMLButtonElement>(`button[data-value="${value}"]`);

function render(props: ChatSessionSharingProps, root: HTMLElement) {
  const update = updates.get(root);
  if (update) {
    update(props);
    flush();
    return;
  }
  mountSolid(
    () => {
      const [current, setCurrent] = createSignal(props);
      updates.set(root, setCurrent);
      return <ChatSessionSharing {...current()} />;
    },
    { container: root },
  );
  flush();
}

async function openMenu(root: HTMLElement) {
  const panel = part(root, "sharing-panel");
  const trigger = root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger");
  if (panel && trigger && !trigger.disabled && !panel.matches(":popover-open")) {
    trigger.click();
    await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(true));
  }
  return panel;
}

async function openAccess(root: HTMLElement) {
  const panel = root.querySelector<HTMLElement>(".chat-pane__sharing-panel")!;
  if (!panel.querySelector('[data-value="access:back"]')) {
    const trigger = panel.querySelector<HTMLButtonElement>('[data-value="access"]');
    expect(trigger).not.toBeNull();
    trigger!.click();
  }
  await waitForSolid(() => {
    expect(panel.matches(":popover-open")).toBe(true);
    expect(panel.querySelector('[data-value="access:back"]')?.textContent).toBe("Back");
    expect(panel.querySelectorAll('[data-value^="visibility:"]')).toHaveLength(4);
    expect(panel.querySelector('[data-value="access"]')).toBeNull();
    expect(panel.querySelector(".chat-pane__sharing-permissions")).toBeNull();
  });
}

async function backToOverview(root: HTMLElement) {
  const panel = root.querySelector<HTMLElement>(".chat-pane__sharing-panel")!;
  const back = panel.querySelector<HTMLButtonElement>('[data-value="access:back"]');
  expect(back).not.toBeNull();
  back!.click();
  await waitForSolid(() => {
    expect(panel.matches(":popover-open")).toBe(true);
    expect(panel.querySelector('[data-value="access"]')).not.toBeNull();
    expect(panel.querySelector('[data-value="access:back"]')).toBeNull();
    expect(panel.querySelectorAll('[data-value^="visibility:"]')).toHaveLength(0);
    expect(document.activeElement).toBe(panel.querySelector('[data-value="access"]'));
  });
}

async function select(root: HTMLElement, value: string) {
  await openMenu(root);
  if (value.startsWith("visibility:")) {
    await openAccess(root);
  }
  const selected = item(root, value);
  if (!selected) {
    throw new Error(`Expected sharing item: ${value}`);
  }
  selected.click();
  await Promise.resolve();
  flush();
}

async function mount(props: Partial<ChatSessionSharingProps>, open = true) {
  container = document.createElement("div");
  document.body.append(container);
  render(renderSharing(props), container);
  if (open) {
    await openMenu(container);
  }
  return container;
}

describe("chat session sharing menu", () => {
  it("reads people only on opening and retains the latest member rows across reopening", async () => {
    const onOpen = vi.fn();
    const readAvatar = vi.fn(() => undefined);
    const sharing = (count: number, selected = false) =>
      renderSharing({
        session: sharingSession({ visibility: "read-only" }),
        onOpen,
        state: sharingState({
          members: selected ? [{ identityId: "person-100", addedBy: "owner", addedAt: 1 }] : [],
          permissions: Array.from({ length: count }, (_, index) => ({
            identityId: `person-${index}`,
            level: selected && index === 100 ? ("send" as const) : ("read" as const),
            options: ["read", "send"] as ("read" | "send")[],
          })),
          identities: Array.from({ length: count }, (_, index) => ({
            type: "human" as const,
            id: `person-${index}`,
            label: `Person ${index} (${count})`,
            get avatarUrl() {
              return readAvatar();
            },
          })),
          allowedVisibilities: ["shared", "read-only"],
        }),
      });
    const root = await mount(sharing(100), false);
    expect(part(root, "sharing-trigger")).not.toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(readAvatar).not.toHaveBeenCalled();
    render(sharing(101), root);
    expect(onOpen).not.toHaveBeenCalled();
    const panel = (await openMenu(root))!;
    expect(panel.matches(":popover-open")).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(readAvatar).toHaveBeenCalled();
    expect(root.querySelectorAll(".chat-pane__sharing-person")).toHaveLength(101);
    const member = root.querySelector<HTMLElement>('[data-value="member:person-100"]');
    const avatar = member?.querySelector("openclaw-session-owner-chip");
    expect(avatar).not.toBeNull();
    render({ ...sharing(102, true), memberRemoveDisabledReason: "Requires write" }, root);
    expect(root.querySelector('[data-value="member:person-100"]')).toBe(member);
    expect(member?.querySelector("openclaw-session-owner-chip")).toBe(avatar);
    expect(item(root, "permission:person-100")).toMatchObject({ title: "Requires write" });
    expect(member && part(member, "sharing-member-label")?.textContent).toBe("Person 100 (102)");
    expect(item(root, "permission:person-100")?.getAttribute("aria-label")).toContain("Can send");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    await openMenu(root);
    expect(root.querySelector('[data-value="member:person-100"]')).toBe(member);
    root.querySelector<HTMLButtonElement>('[aria-label="Search people…"]')!.click();
    flush();
    const search = root.querySelector<HTMLInputElement>("input[data-search]")!;
    expect(document.activeElement).toBe(search);
    search.value = "Person 101";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(root.querySelector("input[data-search]")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(root.querySelectorAll(".chat-pane__sharing-person")).toHaveLength(1);
  });

  it("hides members in Shared and restores them when authoritative visibility changes", async () => {
    const props = renderSharing({
      state: sharingState({
        owner,
        identities: [human("alice", "Alice")],
        permissions: [{ identityId: "alice", level: "read", options: ["read", "send"] }],
      }),
      onPublicShareChange: vi.fn(),
    });
    const root = await mount(props);
    for (const visibility of [
      undefined,
      "read-only",
      "shared",
      "suggest",
      "draft",
      "shared",
    ] as const) {
      render({ ...props, session: sharingSession({ visibility }) }, root);
      const visible = visibility === "read-only" || visibility === "suggest";
      expect(Boolean(part(root, "sharing-permissions"))).toBe(visible);
      expect(Boolean(item(root, "permission:alice"))).toBe(visible);
      expect(Boolean(root.querySelector('[aria-label="Search people…"]'))).toBe(visible);
      expect(root.textContent).toContain("Session access");
      expect(root.textContent).toContain("Link sharing");
    }
    expect(props.onMemberChange).not.toHaveBeenCalled();
    expect(props.onVisibilityChange).not.toHaveBeenCalled();
    expect(props.onPublicShareChange).not.toHaveBeenCalled();
  });

  it("uses server choices for editable and inherited participation", async () => {
    const onMemberChange = vi.fn();
    const result = {
      owner,
      identities: [
        human("owner", "Owner"),
        human("editable", "Alex"),
        human("inherited", "Morgan"),
      ],
      permissions: [
        { identityId: "owner", level: "send" as const, options: ["send"] as "send"[] },
        {
          identityId: "editable",
          level: "read" as const,
          options: ["read", "send"] as ("read" | "send")[],
        },
        { identityId: "inherited", level: "send" as const, options: ["send"] as "send"[] },
      ],
    };
    const props = renderSharing({
      session: sharingSession({ visibility: "read-only" }),
      state: sharingState(result),
      onMemberChange,
    });
    const root = await mount(props);
    expect(root.querySelectorAll('[data-value="member:owner"]')).toHaveLength(1);
    expect(item(root, "member:inherited")).toBeNull();
    const inherited = root.querySelector<HTMLElement>('[data-value="member:inherited"]')!;
    expect(part(inherited, "sharing-permission")?.textContent).toBe("Can send");
    const editable = item(root, "permission:editable")!;
    expect(editable.textContent).toBe("Can read");
    expect(onMemberChange).not.toHaveBeenCalled();
    editable.click();
    await waitForSolid(() => expect(item(root, "permission:send:editable")).not.toBeNull());
    item(root, "permission:send:editable")!.click();
    expect(onMemberChange).toHaveBeenLastCalledWith("editable", true);
    render(
      {
        ...props,
        state: sharingState({
          ...result,
          permissions: [
            { identityId: "editable", level: "send", options: ["read", "send"] },
            result.permissions[2]!,
          ],
        }),
      },
      root,
    );
    expect(editable.textContent).toBe("Can send");
    editable.click();
    await waitForSolid(() => expect(item(root, "permission:read:editable")).not.toBeNull());
    const readOption = item(root, "permission:read:editable")!;
    readOption.click();
    expect(onMemberChange).toHaveBeenLastCalledWith("editable", false);
    render({ ...props, session: sharingSession({ visibility: "shared" }) }, root);
    readOption.click();
    expect(onMemberChange).toHaveBeenCalledTimes(2);
  });

  it("keeps a world-readable draft session visibly public after its menu closes", async () => {
    const session = sharingSession({ visibility: "draft" });
    const state = sharingState({
      allowedVisibilities: ["draft", "read-only"],
      publicShare,
    });
    const renderIndicator = (published: boolean) =>
      renderSharing({
        session,
        state: published ? state : sharingState({ ...state.result, publicShare: undefined }),
        onPublicShareChange: vi.fn(),
      });
    const root = await mount(renderIndicator(true));

    const panel = part(root, "sharing-panel")!;
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    const indicator = root.querySelector('.chat-pane__sharing-trigger[data-public="true"]');
    expect(indicator?.textContent?.trim()).toBe("Public");
    expect(indicator?.getAttribute("title")).toContain("anyone can read");

    render(renderIndicator(false), root);
    expect(root.querySelector('.chat-pane__sharing-trigger[data-public="true"]')).toBeNull();
  });

  it("keeps disabling public access separate from team visibility", async () => {
    const onPublicShareChange = vi.fn();
    const onCopyPublicLink = vi.fn();
    const onVisibilityChange = vi.fn();
    const root = await mount({
      session: sharingSession({ visibility: "draft" }),
      state: sharingState({
        allowedVisibilities: ["draft", "shared"],
        publicShare,
      }),
      onVisibilityChange,
      onPublicShareChange,
      onCopyPublicLink,
    });
    expect(root.textContent).toContain("Link sharing");
    expect(root.textContent).toContain("The public link stays readable in Draft.");
    await select(root, "public:disable");
    expect(onPublicShareChange).toHaveBeenCalledWith(false);
    expect(onVisibilityChange).not.toHaveBeenCalled();
    await select(root, "public:copy");
    expect(onCopyPublicLink).toHaveBeenCalledOnce();
    expect(part(root, "sharing-panel")?.matches(":popover-open")).toBe(true);
  });

  it.each(["loading", "read-only", "member"] as const)(
    "refuses public mutations for %s controls",
    async (blocked) => {
      const onPublicShareChange = vi.fn();
      const root = await mount({
        session: sharingSession({ sharingRole: blocked === "member" ? "member" : "owner" }),
        state: sharingState({}, blocked === "loading"),
        publicShareDisabledReason: blocked === "read-only" ? "Requires write" : undefined,
        onPublicShareChange,
      });
      const dropdown = part(root, "sharing-panel");
      if (blocked === "member") {
        expect(dropdown).toBeNull();
      } else {
        expect(item(root, "public:enable")).toMatchObject({ disabled: true });
        await select(root, "public:enable");
      }
      expect(onPublicShareChange).not.toHaveBeenCalled();
    },
  );

  it("shows the owner picker with policy-gated modes and known identities", async () => {
    const onVisibilityChange = vi.fn();
    const onMemberChange = vi.fn();
    const navigate = vi.fn();
    const root = await mount({
      session: sharingSession({ visibility: "read-only" }),
      state: sharingState({
        owner,
        identities: [human("owner", "Owner"), human("alice", "Alice")],
        permissions: [{ identityId: "alice", level: "read", options: ["read", "send"] }],
        allowedVisibilities: ["shared", "read-only"],
      }),
      ownerViewing: false,
      personActivity: { basePath: "", navigate },
      onVisibilityChange,
      onMemberChange,
    });
    expect(part(root, "sharing-panel")).not.toBeNull();
    await openAccess(root);
    expect(root.textContent).toContain("Shared");
    expect(root.textContent).toContain("Read-only");
    expect(item(root, "visibility:suggest")?.disabled).toBe(true);
    await backToOverview(root);
    expect(root.textContent).toContain("Alice");
    expect(item(root, "member:owner")).toBeNull();
    const ownerRow = part(root, "sharing-person--creator")!;
    expect(ownerRow.textContent).toContain("Owner");
    expect(ownerRow.querySelector("openclaw-session-owner-chip")).not.toBeNull();
    const ownerLink = ownerRow.querySelector<HTMLAnchorElement>("a.person-activity-link");
    expect(ownerLink?.getAttribute("href")).toBe("/activity/owner");
    const ownerAvatarLink = ownerRow.querySelector("a.person-activity-avatar-link");
    expect(ownerAvatarLink).toMatchObject({ tabIndex: -1 });
    expect(ownerAvatarLink?.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector(".session-menu__separator")).toBeNull();

    ownerLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("owner", "Owner");

    await select(root, "visibility:shared");
    await backToOverview(root);
    const access = item(root, "access")!;
    const member = item(root, "permission:alice")!;
    access.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    await waitForSolid(() => expect(document.activeElement).toBe(member));
    member.click();
    await waitForSolid(() => expect(item(root, "permission:send:alice")).not.toBeNull());
    item(root, "permission:send:alice")!.click();
    await waitForSolid(() => expect(onMemberChange).toHaveBeenCalledExactlyOnceWith("alice", true));
    expect(onVisibilityChange).toHaveBeenCalledWith("shared");
    expect(part(root, "sharing-panel")?.matches(":popover-open")).toBe(true);
  });

  it("renders member presentation from identity.type, not from ID spelling", async () => {
    const root = await mount({
      session: sharingSession({ visibility: "read-only" }),
      state: sharingState({
        identities: [
          human("profile-vyctor", "Vyctor Brzezowski"),
          // Human IDs are opaque; recorded type, not ID spelling, drives presentation.
          human("channel:chn_design", "Design"),
          { type: "agent", id: "discord:channel:operations", label: "Operations" },
          { type: "system", id: "channel:audit", label: "Audit" },
        ],
        permissions: [
          { identityId: "profile-vyctor", level: "read", options: ["read", "send"] },
          { identityId: "channel:chn_design", level: "read", options: ["read", "send"] },
        ],
      }),
    });

    for (const id of ["profile-vyctor", "channel:chn_design"]) {
      expect(
        root.querySelector(`[data-value="member:${id}"] openclaw-session-owner-chip`),
      ).not.toBeNull();
    }
    for (const id of ["discord:channel:operations", "channel:audit"]) {
      expect(item(root, `member:${id}`)).toBeNull();
    }
  });

  it("keeps the linked owner beside the draft marker for a non-manager", async () => {
    const root = await mount({
      session: sharingSession({
        visibility: "draft",
        sharingRole: "member",
        owner: { actor: owner },
      }),
      ownerViewing: false,
      personActivity: { basePath: "", navigate: vi.fn() },
      showOwner: true,
    });
    expect(part(root, "sharing-panel")).toBeNull();
    const indicator = part(root, "draft-indicator");
    expect(indicator?.querySelector("svg")).not.toBeNull();
    expect(indicator?.textContent?.trim()).toBe("");
    const ownerLink = root.querySelector<HTMLAnchorElement>(
      "a.person-activity-avatar-link:has(openclaw-session-owner-chip)",
    );
    expect(ownerLink?.getAttribute("href")).toBe("/activity/owner");
    expect(ownerLink).toMatchObject({ tabIndex: 0 });
    expect(ownerLink?.hasAttribute("aria-hidden")).toBe(false);
    ownerLink?.focus();
    expect(document.activeElement).toBe(ownerLink);
  });

  it("keeps read-only owner controls visible but refuses disabled selections", async () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const onMemberChange = vi.fn();
    const root = await mount({
      session: sharingSession({ visibility: "read-only" }),
      state: sharingState({
        members: [{ identityId: "alice", addedBy: "owner", addedAt: 1 }],
        permissions: [
          { identityId: "alice", level: "send", options: ["read", "send"] },
          { identityId: "bob", level: "read", options: ["read", "send"] },
        ],
        identities: [
          human("alice", "Alice with a very long selected member display name"),
          human("bob", "Bob with a very long available member display name"),
        ],
        allowedVisibilities: ["shared", "read-only"],
      }),
      visibilityDisabledReason: "Requires write",
      memberAddDisabledReason: "Requires write",
      memberRemoveDisabledReason: "Requires write",
      onOpen,
      onVisibilityChange,
      onMemberChange,
    });
    expect(part(root, "sharing-panel")).not.toBeNull();
    await openAccess(root);
    expect(item(root, "visibility:read-only")).toMatchObject({ title: "Requires write" });
    await backToOverview(root);
    for (const identityId of ["alice", "bob"]) {
      const member = item(root, `permission:${identityId}`)!;
      expect(member).toMatchObject({ disabled: true, title: "Requires write" });
      expect(
        root
          .querySelector(`[data-value="member:${identityId}"] .chat-pane__sharing-member-label`)
          ?.hasAttribute("title"),
      ).toBe(false);
    }

    await select(root, "visibility:read-only");
    await backToOverview(root);
    await select(root, "permission:alice");
    await select(root, "permission:bob");

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onVisibilityChange).not.toHaveBeenCalled();
    expect(onMemberChange).not.toHaveBeenCalled();
  });

  it("disables opening when sharing reads are unavailable", async () => {
    const onOpen = vi.fn();
    const root = await mount({
      openDisabledReason: "Connect to the Gateway",
      onOpen,
    });

    expect(root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled).toBe(
      true,
    );
    root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.click();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps visibility controls usable without member-list support", async () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const root = await mount({
      allowedVisibilities: ["shared", "read-only"],
      membersAvailable: false,
      onOpen,
      onVisibilityChange,
    });

    expect(root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled).toBe(
      false,
    );
    expect(part(root, "sharing-permissions")).toBeNull();
    expect(root.textContent).not.toContain("Permissions");
    await openAccess(root);
    expect(item(root, "visibility:read-only")).not.toBeNull();

    await select(root, "visibility:read-only");
    await backToOverview(root);
    expect(part(root, "sharing-permissions")).toBeNull();
    expect(root.textContent).not.toContain("Permissions");

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onVisibilityChange).toHaveBeenCalledWith("read-only");
  });

  it("shows rejected sharing changes for visibility-only Gateways", async () => {
    const root = await mount({
      state: { loading: false, error: "Visibility update rejected" },
      allowedVisibilities: ["shared", "read-only"],
      membersAvailable: false,
    });

    const error = part(root, "sharing-status--error");
    expect(error?.textContent).toContain("Visibility update rejected");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(root.textContent).toContain("Session access");
  });
});
