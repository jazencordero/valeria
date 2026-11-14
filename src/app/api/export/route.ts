import { currentUser, NotSignedIn } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { collectExport } from "@/server/export/collect";

// M8-06: "Download my data". One JSON file with everything stored for the
// signed-in user (see src/server/export/collect.ts for what is left out).
// Under Cache Components a GET handler is prerendered unless it reads
// request data; `currentUser()` reads cookies(), so this always runs per request.

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  let userId: string;
  try {
    userId = (await currentUser()).id;
  } catch (error) {
    if (error instanceof NotSignedIn) {
      return Response.json({ error: "not_signed_in" }, { status: 401, headers: NO_STORE });
    }
    throw error;
  }

  const file = await collectExport(db, userId);
  const day = file.exportedAt.slice(0, 10);
  return new Response(JSON.stringify(file, null, 2), {
    headers: {
      ...NO_STORE,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="ready-export-${day}.json"`,
    },
  });
}
