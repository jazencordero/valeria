"use server";

/**
 * M3-39: "Fix this card". The card menu's two choices, as one Server Action.
 *
 * - "This card is wrong" sends `flagged`: the card leaves this session and
 *   every future one (`loadDeck` only returns `active` cards).
 * - "Skip this card for now" sends `suspended`: it leaves the deck too, but
 *   reads as hers to bring back later rather than a broken card.
 *
 * Both go through `flagCard` from M3-17, which only updates a card that is
 * hers. Who she is comes from the session cookie; the browser sends only the
 * card id and the choice, and both are checked before use. Another user's
 * card reads as "not_found", the same as a card that does not exist.
 *
 * Every export of a "use server" file is a public endpoint, so there is no
 * exported helper that takes a user id or a database handle. Tests call the
 * action itself with the session and the store mocked.
 */
import { z } from "zod";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { flagCard, StudyNotFound, type FlagStatus } from "@/server/study/store";

/** `flagged` for "This card is wrong", `suspended` for "Skip this card for now". */
export type DropKind = FlagStatus;

export type DropResult =
  | { ok: true; cardId: string; kind: DropKind }
  | { ok: false; reason: "invalid" | "not_found" | "signed_out" };

const Input = z.object({
  cardId: z.uuid(),
  kind: z.enum(["flagged", "suspended"]),
});

export async function dropCard(cardId: unknown, kind: unknown): Promise<DropResult> {
  const parsed = Input.safeParse({ cardId, kind });
  if (!parsed.success) return { ok: false, reason: "invalid" };

  let userId: string;
  try {
    userId = (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) return { ok: false, reason: "signed_out" };
    throw err;
  }

  try {
    await flagCard(userId, parsed.data.cardId, parsed.data.kind);
  } catch (err) {
    if (err instanceof StudyNotFound) return { ok: false, reason: "not_found" };
    throw err;
  }
  return { ok: true, cardId: parsed.data.cardId, kind: parsed.data.kind };
}
