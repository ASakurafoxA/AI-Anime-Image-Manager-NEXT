import type { ReactNode, Ref } from "react";
import { cn } from "@/utils/tailwind";

interface SettingsPageShellProps {
  children: ReactNode;
  description?: ReactNode;
  headerAction?: ReactNode;
  maxWidth?: "default" | "wide";
  scrollRef?: Ref<HTMLDivElement>;
  title: ReactNode;
}

interface SettingsSectionProps {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  title?: ReactNode;
  /**
   * 自用（2026-10-16）：区块标题的字号。
   * `"section"`（默认）= 现在各设置页用的稍小样式 ✓；
   * `"page"` = 和页面顶部标题（如「应用行为」）**完全一样** ✓ ——
   * 用于"这一块本身就是一个独立话题"的情况（用户要求 ✓）。
   */
  titleVariant?: "page" | "section";
}

export function SettingsPageShell({
  children,
  description,
  headerAction,
  maxWidth = "default",
  scrollRef,
  title,
}: SettingsPageShellProps) {
  return (
    <div
      className="h-full min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain p-3 sm:p-6 min-[480px]:p-4"
      ref={scrollRef}
    >
      <section
        className={cn(
          "mx-auto w-full min-w-0 space-y-4",
          maxWidth === "wide" ? "max-w-[1040px]" : "max-w-[820px]"
        )}
      >
        <header
          className={cn(
            headerAction &&
              "flex min-w-0 flex-col gap-3 min-[600px]:flex-row min-[600px]:items-start min-[600px]:justify-between"
          )}
        >
          <div className="min-w-0">
            <h2 className="font-semibold text-[14px] text-foreground">
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
                {description}
              </p>
            )}
          </div>
          {headerAction && <div className="shrink-0">{headerAction}</div>}
        </header>
        {children}
      </section>
    </div>
  );
}

export function SettingsSection({
  children,
  className,
  description,
  title,
  titleVariant = "section",
}: SettingsSectionProps) {
  const isPageTitle = titleVariant === "page";
  return (
    <section className={cn("min-w-0 space-y-3", className)}>
      {(title || description) && (
        <div>
          {title &&
            (isPageTitle ? (
              // 与 SettingsPageShell 的标题样式保持一致 ✓
              <h2 className="font-semibold text-[14px] text-foreground">
                {title}
              </h2>
            ) : (
              <h3 className="font-medium text-[13px] text-foreground">
                {title}
              </h3>
            ))}
          {description && (
            <p
              className={cn(
                "text-muted-foreground [overflow-wrap:anywhere]",
                isPageTitle ? "mt-1 text-[12px]" : "mt-0.5 text-[11px]"
              )}
            >
              {description}
            </p>
          )}
        </div>
      )}
      <div
        className="min-w-0 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4"
        data-surface="card"
      >
        {children}
      </div>
    </section>
  );
}
