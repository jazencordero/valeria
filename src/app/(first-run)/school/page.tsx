/**
 * Choose your school (M5-04): between Welcome and Connect. Continue stores her
 * pick in `users.school` (`chooseSchoolAction`) and goes to /connect.
 *
 * Fully static like Welcome: the school list comes from src/lib/schools.ts and
 * no cookie is read here, so it prerenders under cacheComponents. The action
 * finds her user from the cookie when she presses Continue.
 */
import type { Metadata } from "next";
import { SchoolPick, type SchoolCard, type SchoolTone } from "@/components/first-run/school-pick";
import { canConnect, SCHOOL_IDS, SCHOOLS } from "@/lib/schools";
import { chooseSchoolAction } from "./actions";

export const metadata: Metadata = { title: "Choose your school · Ready" };

/** Card colours in list order, as in the prototype (Aalto butter, LUT mint). */
const TONES: readonly SchoolTone[] = ["butter", "mint"];

const CARDS: SchoolCard[] = SCHOOL_IDS.map((id, index) => {
  const school = SCHOOLS[id];
  return {
    id,
    name: school.name,
    full: school.full,
    where: school.where,
    quip: school.quip,
    enabled: canConnect(id),
    tone: TONES[index % TONES.length],
  };
});

export default function SchoolPage() {
  return (
    <main>
      <SchoolPick schools={CARDS} choose={chooseSchoolAction} />
    </main>
  );
}
