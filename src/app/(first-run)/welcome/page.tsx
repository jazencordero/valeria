/**
 * Welcome (M5-02): the first screen a new student sees. Get started goes to
 * /school (M5-04).
 *
 * Fully static: no cookie, no data, so it prerenders under cacheComponents.
 * The theme comes from the root layout's boot script, not from the server.
 */
import type { Metadata } from "next";
import { Welcome } from "@/components/first-run/welcome";

export const metadata: Metadata = { title: "Welcome · Ready" };

export default function WelcomePage() {
  return (
    <main>
      <Welcome />
    </main>
  );
}
