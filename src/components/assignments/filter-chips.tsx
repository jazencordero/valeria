"use client";

/**
 * Course filter for the Assignments tab: All plus each visible course.
 * Source: prototype main-flow.html HTML 1541-1547 (.filters, .chip.filt) and
 * CSS 773-776.
 *
 * The choice lives in the `?course=` query so sidebar links work; pressing a
 * chip replaces the URL and the server page renders the new list. The pressed
 * chip moves at once while the list loads.
 */
import { usePathname, useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";
import { Chip, ChipRow } from "@/components/ui/chip";

export type FilterChipsProps = {
  courses: { id: string; name: string }[];
  /** The chosen course id, or `null` for All. */
  selected: string | null;
};

export function FilterChips({ courses, selected }: FilterChipsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(selected);

  function choose(id: string | null) {
    if (id === shown) return;
    startTransition(() => {
      setShown(id);
      router.replace(id ? `${pathname}?course=${encodeURIComponent(id)}` : pathname, { scroll: false });
    });
  }

  return (
    <ChipRow bleed={20} role="group" aria-label="Filter by course" className="mt-4 mb-2">
      <Chip pressed={shown === null} onClick={() => choose(null)}>
        All
      </Chip>
      {courses.map((c) => (
        <Chip key={c.id} pressed={shown === c.id} onClick={() => choose(c.id)}>
          {c.name}
        </Chip>
      ))}
    </ChipRow>
  );
}
