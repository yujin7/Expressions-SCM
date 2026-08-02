import {
  getConnectorReadiness,
  type ConnectorReadiness,
} from "@/server/integrations/connector";

export interface ConnectorReadinessAudit {
  generatedAt: string;
  summary: {
    total: number;
    codeReady: number;
    configured: number;
    explicitlyEnabled: number;
    contractSetsSelected: number;
    configurationReady: number;
    operational: number;
  };
  connectors: ConnectorReadiness[];
}

/**
 * Safe, database-free integration preflight. The registry returns environment variable names and
 * non-secret UAT references only; credential values, tenant/org IDs, endpoints and contracts are
 * deliberately absent so this JSON can be attached to an internal release ticket.
 */
export function auditConnectorReadiness(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): ConnectorReadinessAudit {
  const connectors = getConnectorReadiness(env, now);
  return {
    generatedAt: now.toISOString(),
    summary: {
      total: connectors.length,
      codeReady: connectors.filter((row) => row.implementation === "ready").length,
      configured: connectors.filter((row) => row.configured).length,
      explicitlyEnabled: connectors.filter((row) => row.enablementState === "enabled").length,
      contractSetsSelected: connectors.filter((row) =>
        row.contractSelectionState === "selected").length,
      configurationReady: connectors.filter((row) => row.configurationReady).length,
      operational: connectors.filter((row) => row.operational).length,
    },
    connectors,
  };
}
