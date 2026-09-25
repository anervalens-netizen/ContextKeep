import {
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";
import { APP_VERSION } from "../db/bootstrap.js";
import { SERVER_SCHEMA_VERSION } from "../db/schema-version.js";

export const MCP_VERSION = "2.10.1";
export const MCP_CONTRACT_VERSION = "mcp-first-v1";
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const SUPPORTED_MCP_PROTOCOLS = [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS] as const;

export type RuntimeMetadata = {
  buildSha: string | null;
  applicationVersion: string;
  mcpVersion: string;
  mcpContractVersion: string;
  schemaVersion: number;
  protocols: {
    latest: string;
    supported: string[];
  };
};

export function runtimeMetadata(buildSha: string | null): RuntimeMetadata {
  return {
    buildSha,
    applicationVersion: APP_VERSION,
    mcpVersion: MCP_VERSION,
    mcpContractVersion: MCP_CONTRACT_VERSION,
    schemaVersion: SERVER_SCHEMA_VERSION,
    protocols: {
      latest: MODERN_PROTOCOL_VERSION,
      supported: [...SUPPORTED_MCP_PROTOCOLS],
    },
  };
}
