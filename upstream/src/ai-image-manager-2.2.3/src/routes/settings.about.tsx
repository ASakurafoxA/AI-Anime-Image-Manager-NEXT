import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, Sparkles } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AboutAuthor, AboutProjectAuthor } from "@/components/about/about-author";
import { AboutGallery } from "@/components/about/about-gallery";
import { APP_REPOSITORY_URL, PRIVATE_BUILD } from "@/config/private-build";
import "@/components/about/about.css";
import { AnimatedGitHubButton } from "@/components/animated-github-button";
import { ConfettiOverlay } from "@/components/ConfettiOverlay";
import { SignatureOverlay } from "@/components/SignatureOverlay";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

const DEPENDENCIES = [
  { name: "Electron", version: "41" },
  { name: "React", version: "19" },
  { name: "Vite", version: "8" },
  { name: "TypeScript", version: "6" },
  { name: "Tailwind CSS", version: "4" },
  { name: "TanStack Router", version: "1" },
  { name: "TanStack Query", version: "5" },
  { name: "Drizzle ORM", version: "0.44" },
  { name: "better-sqlite3", version: "12" },
  { name: "Sharp", version: "0.34" },
  { name: "ONNX Runtime", version: "1.26" },
  { name: "LanceDB", version: "0.18" },
  { name: "i18next", version: "26" },
  { name: "GSAP", version: "3" },
];

const EASTER_EGG_CLICKS = 7;
const AboutCrowd = lazy(() => import("@/components/about/about-crowd"));

function AboutSettingsPage() {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState("");
  const [depsExpanded, setDepsExpanded] = useState(false);
  const [confettiActive, setConfettiActive] = useState(false);
  const [signatureActive, setSignatureActive] = useState(false);
  const [easterEggFound, setEasterEggFound] = useState(false);
  const clickCountRef = useRef(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  useEffect(() => {
    ipc.client.app.appVersion({}).then((v) => setAppVersion(v as string));
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleVersionClick = useCallback(() => {
    clickCountRef.current += 1;

    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = setTimeout(() => {
      clickCountRef.current = 0;
    }, 1500);

    if (clickCountRef.current >= EASTER_EGG_CLICKS) {
      clickCountRef.current = 0;
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
      setEasterEggFound(true);
      setConfettiActive(true);
    }
  }, []);

  const handleConfettiMidpoint = useCallback(() => {
    setSignatureActive(true);
  }, []);

  const handleConfettiDone = useCallback(() => {
    setConfettiActive(false);
  }, []);

  const handleSignatureDone = useCallback(() => {
    setSignatureActive(false);
  }, []);

  return (
    <SettingsPageShell scrollRef={scrollRef} title={t("settingsAbout")}>
      <ConfettiOverlay
        active={confettiActive}
        onDone={handleConfettiDone}
        onMidpoint={handleConfettiMidpoint}
      />
      <SignatureOverlay active={signatureActive} onDone={handleSignatureDone} />

      <div className="mx-auto w-full min-w-0 max-w-[820px] space-y-6">
        {/* App info */}
        <section className="space-y-3">
          <div className="min-w-0 space-y-3 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] text-muted-foreground">
                {t("settingsVersion")}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={t("settingsVersion")}
                    className="group relative flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[13px] text-foreground transition-colors hover:bg-foreground/5"
                    onClick={handleVersionClick}
                    type="button"
                  >
                    <span className="select-none">{appVersion || "..."}</span>
                    {easterEggFound && (
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("settingsVersion")}</TooltipContent>
              </Tooltip>
            </div>

            {/* License */}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-border border-t pt-3">
              <span className="text-[13px] text-muted-foreground">
                {t("settingsLicense")}
              </span>
              <span className="text-[13px] text-foreground">MIT</span>
            </div>

            {/* 源项目作者（上游 Uyoung666/ai-image-manager 的 Uyoung） */}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-border border-t pt-3">
              <span className="text-[13px] text-muted-foreground">
                {t("settingsAuthor")}
              </span>
              <AboutAuthor />
            </div>

            {/* 自用新增：本项目作者（需求 8：点名字跳个人主页，悬停显示网址） */}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-border border-t pt-3">
              <span className="text-[13px] text-muted-foreground">
                {t("settingsProjectAuthor")}
              </span>
              <AboutProjectAuthor />
            </div>
          </div>
        </section>

        {/* 自用版：去掉「灵感切片」图片轮播 */}
        {!PRIVATE_BUILD.hideAboutExtras && <AboutGallery />}

        {/* 自用：两个同款 3D 翻转链接按钮。
            左 = 源项目：**不传 variant**，与上游原样一致（黑正面 #222229 → 粉翻面 #ff98a2）。
            右 = 本项目：variant="mine"，蓝 → 粉（正面 #2563eb / 图标块 #3b82f6 /
            翻面沿用上游那个粉 #ff98a2）。
            右边原来是「访问项目网站」的黄色圆形按钮（AnimatedNameLoader，
            跳转 https://ai-image-manager.uyoungvision.cn/），按要求改成项目链接按钮。 */}
        <div className="flex min-w-0 flex-wrap items-center gap-3 pt-1">
          <AnimatedGitHubButton href="https://github.com/Uyoung666/ai-image-manager" />
          {/* 自用（需求 8）：这里原来三个版本都跳个人主页，现在跳**本版本的仓库**；
              跳个人主页的功能移到了上面的「本项目作者」名字上。 */}
          <AnimatedGitHubButton
            href={APP_REPOSITORY_URL}
            label={t("settingsGitHubMine")}
            variant="mine"
          />
        </div>

        {/* Dependencies (collapsible) */}
        <section className="space-y-3">
          <button
            aria-controls="about-dependencies"
            aria-expanded={depsExpanded}
            className="flex w-full items-center gap-1.5 text-left font-semibold text-[14px] text-foreground hover:text-foreground/80"
            onClick={() => setDepsExpanded(!depsExpanded)}
            type="button"
          >
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                depsExpanded ? "" : "-rotate-90"
              }`}
            />
            <span>{t("settingsDependencies")}</span>
            <span className="font-normal text-[11px] text-muted-foreground/50">
              ({DEPENDENCIES.length})
            </span>
          </button>
          {depsExpanded && (
            <div
              className="min-w-0 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4"
              id="about-dependencies"
            >
              <div className="space-y-1">
                {DEPENDENCIES.map((dep) => (
                  <div
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-0.5"
                    key={dep.name}
                  >
                    <span className="text-[12px] text-muted-foreground/80">
                      {dep.name}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground/50">
                      v{dep.version}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
        {/* 自用版：去掉「开源依赖」下面那部分（致谢文字 + 播放人群动画开关 + 人群动画） */}
        {!PRIVATE_BUILD.hideAboutExtras && (
          <Suspense fallback={<div className="h-[220px]" />}>
            <AboutCrowd />
          </Suspense>
        )}
      </div>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/about")({
  component: AboutSettingsPage,
});
