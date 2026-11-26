// Side-effect import that scrubs ambient SanRemes env before a module snapshots it (scripts/mcp-server.ts reads
// OPENSANREMES_URL / SANREMES_PORT at evaluation). Import order is the contract: keep it above the module under test.
import { isAmbientOmbKey } from "./sanremes-env.ts";

for (const key of Object.keys(process.env)) {
  if (isAmbientOmbKey(key)) delete process.env[key];
}
