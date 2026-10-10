import { type CSSProperties, useState } from "react";
import { useTranslation } from "react-i18next";
import { openExternalLink } from "@/actions/shell";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AUTHOR_HOMEPAGE_URL } from "@/config/private-build";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

interface AuthorLine {
  id: string;
  text: string;
}

/**
 * 作者名字的逐字动画内容。两个作者组件共用，DOM 结构与上游保持一致
 * （`.about-author-line` / `-word` / `-letter-window` / `-letter`，CSS 见 about.css）。
 */
function AboutAuthorLetters({
  current,
  lines,
}: {
  current: number;
  lines: AuthorLine[];
}) {
  return (
    <>
      {lines.map(({ id, text }, messageIndex) => {
        const words = text.split(" ");
        return (
          <span
            aria-hidden="true"
            className="about-author-line"
            data-active={current === messageIndex}
            key={id}
          >
            {words.map((word, wordIndex) => (
              <span
                className="about-author-word"
                key={words.slice(0, wordIndex + 1).join(" ")}
              >
                {Array.from(word, (letter, letterIndex) => (
                  <span
                    className="about-author-letter-window"
                    key={word.slice(0, letterIndex + 1)}
                  >
                    <span
                      className="about-author-letter"
                      style={
                        {
                          "--letter-delay": `${Math.min(wordIndex * 3 + letterIndex, 8) * 18}ms`,
                        } as CSSProperties
                      }
                    >
                      {letter}
                    </span>
                  </span>
                ))}
              </span>
            ))}
          </span>
        );
      })}
    </>
  );
}

export function AboutAuthor() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const messages = [
    { id: "name", text: "Uyoung" },
    { id: "greeting", text: t("aboutAuthorGreeting") },
    { id: "message", text: t("aboutAuthorMessage") },
  ];
  const greeting = hovered || focused ? 1 : 0;
  const current = showMessage ? 2 : greeting;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`${messages[current].text} · ${t("aboutAuthorHint")}`}
          className="about-author"
          data-message={messages[current].id}
          data-reduced-motion={reduceMotion}
          onBlur={() => {
            setFocused(false);
            setShowMessage(false);
          }}
          onClick={() => setShowMessage((previous) => !previous)}
          onFocus={() => setFocused(true)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => {
            setHovered(false);
            setShowMessage(false);
          }}
          type="button"
        >
          <AboutAuthorLetters current={current} lines={messages} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{t("aboutAuthorHint")}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 自用（需求 8）：本项目作者（ASakurafoxA）。
 *
 * 效果与原作者那一处一致（逐字动画 + 悬停变主题色 + 气泡提示），区别是：
 *  · 悬停时显示的"紫色内容"= **个人主页网址**
 *  · 提示文案 =「点击跳转个人主页」
 *  · 单击 = 打开个人主页（原来这个功能挂在"本项目主页"按钮上，
 *    现在那个按钮改为跳**本版本的仓库**）
 */
export function AboutProjectAuthor() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const lines: AuthorLine[] = [
    { id: "name", text: "ASakurafoxA" },
    { id: "homepage", text: AUTHOR_HOMEPAGE_URL },
  ];
  const current = hovered || focused ? 1 : 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`${lines[current].text} · ${t("aboutProjectAuthorHint")}`}
          className="about-author"
          data-message={lines[current].id}
          data-reduced-motion={reduceMotion}
          onBlur={() => setFocused(false)}
          onClick={() => {
            void openExternalLink(AUTHOR_HOMEPAGE_URL);
          }}
          onFocus={() => setFocused(true)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          type="button"
        >
          <AboutAuthorLetters current={current} lines={lines} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{t("aboutProjectAuthorHint")}</TooltipContent>
    </Tooltip>
  );
}
