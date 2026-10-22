import type { JSX } from "@solidjs/web";
import { createMemo, Errored, isPending, latest, Loading, type Accessor } from "solid-js";
import type { PageReadResult } from "../../lib/page-request.ts";

export function createUsageRead(
  source: () => Promise<PageReadResult> | null,
  readError: () => string | null,
) {
  // The page projection also publishes filters and chart controls. Only a new
  // admitted receipt or recorded failure changes this read's readiness.
  const receipt = createMemo(source);
  const error = createMemo(readError);
  return createMemo(() => {
    const pending = receipt();
    const message = error();
    if (!pending) {
      if (message) {
        throw new Error(message);
      }
      return null;
    }
    return Promise.resolve(pending).then((result) => {
      if (result) {
        throw result.error;
      }
      if (message) {
        throw new Error(message);
      }
      return null;
    });
  });
}

/** Errors add the owner's status without replacing its accepted charts or rows. */
export function UsageReadStatus(props: { read: Accessor<null>; children: () => JSX.Element }) {
  return (
    <Loading fallback={props.children()}>
      <Errored fallback={() => props.children()}>
        {latest(props.read)}
        {props.children()}
      </Errored>
    </Loading>
  );
}

export function UsagePending(props: {
  read: Accessor<null>;
  children: (pending: Accessor<boolean>) => JSX.Element;
}) {
  const pending = () => isPending(props.read);
  return <Loading fallback={props.children(() => true)}>{props.children(pending)}</Loading>;
}
