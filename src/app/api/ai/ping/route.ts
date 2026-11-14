import { z } from "zod";
import { aiRoute } from "@/server/ai/doorway";

// M2-05: proves the AI keys work. Asks the small model to reply with the word "ready".
// Without any key configured the router throws AiBusy and the doorway answers 503.

export const POST = aiRoute(
  async ({ ai }) => {
    const { text, provider, model } = await ai.runText({
      system: "You are a health check. Reply with exactly one word.",
      messages: [{ role: "user", content: "Reply with the word ready." }],
      job: "ping",
    });
    const ok = /\bready\b/i.test(text);
    return { ok, provider, model };
  },
  { size: "small", perUserPerHour: 10, body: z.object({}).strict() },
);
