#!/usr/bin/env node

/**
 * Stdio Server Entry Point.
 *
 * Speaks the MCP protocol over stdin/stdout for local clients that spawn the
 * server as a child process (Claude Desktop, Cursor, OpenWebUI/mcpo, ...).
 *
 * Note: src/index.ts is a one-shot CLI that reads a single JSON ToolCall from
 * stdin and exits — it is not an MCP transport. Use this entry point instead.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, SERVER_NAME, pkgVersion } from "./mcp-server.js";

async function main(): Promise<void> {
  const { server } = createMcpServer();
  const transport = new StdioServerTransport();

  // stdout carries the JSON-RPC stream, so all logging must go to stderr.
  console.error(`${SERVER_NAME} ${pkgVersion} (stdio) ready`);

  await server.connect(transport);

  const shutdown = () => {
    server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
