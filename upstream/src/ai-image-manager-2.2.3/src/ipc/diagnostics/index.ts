import {
  createDiagnosticsBundle,
  dismissDiagnosticIncident,
  exportDiagnosticLog,
  getDiagnosticsOverview,
  recordRendererIncident,
} from "./handlers";

export const diagnostics = {
  getDiagnosticsOverview,
  recordRendererIncident,
  createDiagnosticsBundle,
  exportDiagnosticLog,
  dismissDiagnosticIncident,
};
