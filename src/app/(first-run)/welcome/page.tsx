/**
 * Welcome (M5-02): the first screen a new student sees, and where a signed-out
 * visitor lands (M5-14). Sign up goes to /signup and then the first run
 * (/school, M5-04); Log in goes to /login.
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
