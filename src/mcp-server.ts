/**
 * Shared MCP server factory.
 *
 * Builds the tool surface once so every transport entry point exposes an
 * identical server. Used by src/stdio-server.ts (stdio) and
 * src/http-server.ts (Streamable HTTP).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { LawMcpShell } from "./shell/shell.js";
import { germanyAdapter } from "./adapters/de.js";
import { getCapabilities, getDb, getMetadata } from "./db/german-law-db.js";
import { getPremiumTools } from "./premium-tools.js";
import { responseMeta } from "./utils/metadata.js";
import type { ComplianceMeta } from "./utils/metadata.js";
import type { ToolName } from "./shell/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SERVER_NAME = "german-law-mcp";

export const pkgVersion: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    ) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
})();

function buildComplianceMeta(): ComplianceMeta {
  try {
    const dbMeta = getMetadata();
    return responseMeta(dbMeta.built_at ?? new Date().toISOString().substring(0, 10));
  } catch {
    return responseMeta(new Date().toISOString().substring(0, 10));
  }
}

export function createMcpServer(): { server: Server; shell: LawMcpShell } {
  const meta = buildComplianceMeta();

  const enrichedAdapter = {
    ...germanyAdapter,
    getDbCapabilities: () => getCapabilities(),
  };
  const shell = LawMcpShell.fromAdapters([enrichedAdapter]);

  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  // Detect premium tools using the SDK's public API instead of wrapping
  // internal _requestHandlers (which broke in SDK v1.27.1).
  let premium: ReturnType<typeof getPremiumTools> = null;
  try {
    const db = getDb();
    if (db) {
      premium = getPremiumTools(db);
    }
  } catch (err) {
    console.warn(`[${SERVER_NAME}] Premium tools not available:`, err);
  }

  const premiumToolNames = new Set(premium?.handlers.keys() ?? []);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const definitions = shell.getToolDefinitions();
    const baseTools = definitions.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    }));

    if (!premium) return { tools: baseTools };

    // Deduplicate: premium tools override base tools with the same name
    const filtered = baseTools.filter((t) => !premiumToolNames.has(t.name));
    return { tools: [...filtered, ...premium.tools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Premium tool — handle directly
    const premiumHandler = premium?.handlers.get(toolName);
    if (premiumHandler) {
      try {
        const rawData = premiumHandler(args);
        // Attach _meta compliance block to premium tool responses
        const data =
          rawData !== null && rawData !== undefined && typeof rawData === "object"
            ? { ...(rawData as Record<string, unknown>), _meta: meta }
            : rawData;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                _error_type: "internal_error",
                code: "internal_error",
                message: `Error executing ${toolName}: ${message}`,
                _meta: meta,
              }),
            },
          ],
          isError: true,
        };
      }
    }

    // Base tool — delegate to shell
    const result = await shell.handleToolCall({
      name: toolName as ToolName,
      arguments: args,
    });

    if (result.ok) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
        ],
      };
    }

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result.error, null, 2) },
      ],
      isError: true,
    };
  });

  return { server, shell };
}
