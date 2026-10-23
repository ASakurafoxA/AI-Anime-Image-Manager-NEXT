import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/tailwind";

/**
 * 自用（2026-10-23 · 会话#10）：**可见才加载的缩略图**。
 *
 * 背景：角色识别两个弹窗一次要渲染 200 组 × 5 张 = 上千个 `<img>`。
 * `loading="lazy"` 在这种"固定高度的弹窗滚动区"里不够 —— 浏览器仍会先发一堆请求，
 * 再加上 1000 张 webp 的解码/内存，打开就要等很久（用户实测反馈「缩略图加载好慢」）。
 *
 * 这里用 IntersectionObserver：**滚到附近（提前 400px）才设置 src**，
 * 屏幕外的组不请求、不解码；占位是同样的尺寸 + 浅底色，滚过去时不会跳动。
 */
export function LazyThumb({
  alt = "",
  className,
  onClick,
  src,
  title,
}: {
  alt?: string;
  className?: string;
  onClick?: () => void;
  src: string;
  title?: string;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (visible) {
      return;
    }
    const element = wrapperRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div
      className={cn("relative overflow-hidden bg-muted/60", className)}
      onClick={onClick}
      ref={wrapperRef}
      title={title}
    >
      {visible && (
        <img
          alt={alt}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-150",
            loaded ? "opacity-100" : "opacity-0"
          )}
          decoding="async"
          onLoad={() => setLoaded(true)}
          src={src}
        />
      )}
    </div>
  );
}
