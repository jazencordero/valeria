/**
 * Starts the fake AI for the whole-flow tests (M2-23) and stops it when they end.
 *
 * It runs here, in Playwright's runner process, on the port playwright.config.ts picked and put
 * in AI_FAKE_URL. The app's dev server gets the same AI_FAKE_URL (webServer.env) and sends every
 * AI call there instead of to a provider (src/server/ai/router.ts, `fakeAiUrl`). Tests run in
 * worker processes and script it over HTTP: `connectFakeAi(process.env.AI_FAKE_URL!)`.
 */
import { startFakeAi } from "../fake-ai/server";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const url = new URL(process.env.AI_FAKE_URL ?? "");
  const ai = await startFakeAi({ host: url.hostname, port: Number(url.port) });
  return () => ai.close();
}
