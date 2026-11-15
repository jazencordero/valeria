"use client";
/**
 * Usage beacon (M8-28): tells the server "she is looking at this page" once
 * per page, so it can log an `open` (throttled to one per 30 minutes on the
 * server) and, on an assignment or study page, a `start`. Renders nothing.
 *
 * Mounted from `src/app/(app)/template.tsx`, which passes `send`: a server
 * action defined inline there (a client file cannot define one). The
 * template remounts only when the first segment changes (/home to
 * /assignments), not from /assignments to /assignments/<id>, so the beacon
 * also sends again when the path changes. A ref keeps it to one send per
 * path, also under React's development double effect.
 *
 * Failures are swallowed: usage logging must never break a page.
 */
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export function Beacon({ send }: { send: (path: string) => Promise<void> }) {
  const pathname = usePathname();
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || sent.current === pathname) return;
    sent.current = pathname;
    send(pathname).catch(() => {});
  }, [pathname, send]);

  return null;
}
