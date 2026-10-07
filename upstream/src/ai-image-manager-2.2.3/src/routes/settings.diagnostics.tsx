import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { DiagnosticsReportForm } from "@/components/diagnostics-report-form";
import { PRIVATE_BUILD } from "@/config/private-build";
import {
  SettingsPageShell,
  SettingsSection,
} from "@/components/settings/settings-page-shell";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

function DiagnosticsSettingsPage() {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  return (
    <SettingsPageShell
      description={t("diagnosticsDescription")}
      scrollRef={scrollRef}
      title={t("settingsDiagnostics")}
    >
      <SettingsSection
        description={t("diagnosticsSectionDescription")}
        title={t("diagnosticsReportProblem")}
      >
        {PRIVATE_BUILD.disableDiagnostics ? (
          <p className="text-muted-foreground text-sm">
            此功能已在自用版中停用。故障记录仍保存在本地
            diagnostics/incidents.jsonl，需要时可直接查看该文件。
          </p>
        ) : (
          <DiagnosticsReportForm />
        )}
      </SettingsSection>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/diagnostics")({
  component: DiagnosticsSettingsPage,
});
