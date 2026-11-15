/**
 * Wraps every signed-in page (M8-28) so the layout file stays untouched: the
 * page as it is, plus the usage beacon, which renders nothing.
 *
 * `pageView` is an inline server action (the only kind a server component
 * can hand to a client component without its own "use server" file). It is
 * reachable by a direct POST like any action, so it trusts nothing from the
 * browser: the user comes from the session cookie, and the path only picks
 * whether a `start` is logged as well (`recordPageView`). No session, a demo
 * user or any error: nothing is logged and nothing is thrown.
 */
import { Suspense, type ReactNode } from "react";
import { Beacon } from "@/components/usage/beacon";
import { currentUser } from "@/server/auth/session";
import { recordPageView } from "@/server/usage/log";

async function pageView(path: string): Promise<void> {
  "use server";
  try {
    const user = await currentUser();
    if (user.settings?.demo === true) return;
    await recordPageView(user.id, typeof path === "string" ? path.slice(0, 200) : null);
  } catch {
    // Not signed in yet, or the database is away: usage logging never breaks a page.
  }
}

export default function AppTemplate({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      {/* usePathname is request data: under cacheComponents it must sit inside Suspense. */}
      <Suspense fallback={null}>
        <Beacon send={pageView} />
      </Suspense>
    </>
  );
}
