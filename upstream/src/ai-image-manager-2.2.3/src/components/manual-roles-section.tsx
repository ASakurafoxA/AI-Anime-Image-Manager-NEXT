/**
 * 人物识别页面里的「我创建的角色」区块（NEXT 版新增）。
 *
 * 用户口径（第三、四批实测反馈）：
 *   · 这里只出现**手动新建**的角色；选已有标签导入的不算 ✗；
 *   · 「遇到不符合的也能直接退回未命名列表」→ 展开后可勾选，点「退回未命名」把这些图
 *     从该角色上撤下来，并**放回待命名列表**（下次打开「发现没有标签的角色」就能看到）✓；
 *   · ⚠️ **样式必须保持原来的卡片**（不要改成列表行 ✗）；
 *     卡片**右上角**放「展开图集」按钮；「改名」做成**按钮**（与设置里的按钮同款），
 *     名字/张数/按钮**一行内垂直居中**、位置规整 ✓。
 */
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Image as ImageIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { toast } from "sonner";
import { faceActions } from "@/actions/faces";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PhotoLightbox, type LightboxPhoto } from "@/components/PhotoLightbox";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { toLocalMediaUrl } from "@/utils/local-media-url";

export interface ManualRole {
  createdAt: number;
  photoCount: number;
  representativePhotoId: number;
  tagId: number;
  tagName: string;
  thumbnailPath: string | null;
}

type RolePhoto = LightboxPhoto;

export interface ManualRolesSectionProps {
  roles: ManualRole[];
  /** 数据变化后让上层刷新列表 */
  onRenamed?: () => void;
}

/** 与"设置"里同款的按钮样式（有边框、圆角、内边距）。 */
const BUTTON_CLASS =
  "rounded-[6px] border border-border bg-card px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50";

export function ManualRolesSection({ roles, onRenamed }: ManualRolesSectionProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  /*
   * 自用（2026-10-18 · 会话#9 用户要求）：「动画要能和设置里那个减少动画的选项关联」✓
   * 设置页的「减少动画」开着时（或系统 prefers-reduced-motion），这里直接不加动画类 ✓
   */
  const reduceMotion = useReducedMotion();
  const enterClass = reduceMotion ? "" : "album-view-enter";
  const menuClass = reduceMotion ? "" : "context-menu-pop";
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  /**
   * 展开的角色 → 整组照片（懒加载）。
   * 自用（2026-10-18 · 会话#9 用户口径：「展开之后整个界面就像进入这个文件夹一样」）：
   * 改成**同一时间只展开一个**，展开时整块换成"图集视图"（不再是卡片里塞小格子）✓
   */
  const [expandedTagId, setExpandedTagId] = useState<number | null>(null);
  const [photos, setPhotos] = useState<Record<number, RolePhoto[]>>({});
  /** 每个角色勾选了哪些图（用于"退回未命名"） */
  const [selection, setSelection] = useState<Record<number, Set<number>>>({});
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [returning, setReturning] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState<{
    count: number;
    role: ManualRole;
  } | null>(null);
  const [lightbox, setLightbox] = useState<{
    index: number;
    photos: RolePhoto[];
  } | null>(null);
  /*
   * 自用（2026-10-18 · 会话#9 用户要求）：**右键图片 → 设为图集封面** ✓
   * 只改 manualRoles 里那条记录的封面字段，不动标签/照片
   */
  const [coverMenu, setCoverMenu] = useState<{
    photo: RolePhoto;
    tagId: number;
    x: number;
    y: number;
  } | null>(null);
  const [settingCover, setSettingCover] = useState(false);

  async function setAsCover() {
    if (!coverMenu || settingCover) {
      return;
    }
    setSettingCover(true);
    try {
      const { tagId, photo } = coverMenu;
      await faceActions.setManualRoleCover({
        tagId,
        photoId: photo.id,
        thumbnailPath: photo.thumbnailPath || photo.path,
      });
      setCoverMenu(null);
      toast.success(t("manualRolesCoverUpdated"));
      onRenamed?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingCover(false);
    }
  }

  /** 标签变了 → 通知侧边栏标签树 & react-query 缓存 */
  function notifyTagChange() {
    window.dispatchEvent(new Event("tags-changed"));
    void queryClient.invalidateQueries({ queryKey: ["tags"] });
  }

  async function save(tagId: number) {
    const name = draft.trim();
    if (name.length === 0 || saving) {
      return;
    }
    setSaving(true);
    try {
      const result = (await faceActions.renameManualCharacterRole({
        tagId,
        name,
      })) as { tagName: string };
      toast.success(t("manualRolesRenamed", { name: result.tagName }));
      // 改的是**标签名**，所以标签树也要刷新（否则树上还挂着旧名字）
      notifyTagChange();
      setEditingId(null);
      setDraft("");
      onRenamed?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  /** 展开/收起；展开时按需拉该角色下的整组照片。 */
  async function toggleExpand(role: ManualRole) {
    if (expandedTagId === role.tagId) {
      setExpandedTagId(null);
      return;
    }
    setExpandedTagId(role.tagId);
    if (photos[role.tagId]) {
      return;
    }
    setLoadingId(role.tagId);
    try {
      const result = (await faceActions.listTagPhotos(role.tagId)) as {
        photos?: RolePhoto[];
      };
      setPhotos((prev) => ({ ...prev, [role.tagId]: result?.photos ?? [] }));
    } catch (error) {
      /*
       * 主进程新增的接口**必须完全重启应用**才生效（前端热更新管不到主进程）。
       * 没重启时这里会失败，所以提示里把这条说清楚，别让用户以为是功能坏了。
       */
      toast.error(
        error instanceof Error
          ? `${error.message}（若刚更新过代码，请完全关闭并重新打开软件）`
          : String(error)
      );
    } finally {
      setLoadingId(null);
    }
  }

  function toggleSelect(tagId: number, photoId: number) {
    setSelection((prev) => {
      const next = new Set(prev[tagId] ?? []);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return { ...prev, [tagId]: next };
    });
  }

  /** 把勾选的图从该角色上撤下来（退回未命名）。 */
  async function doReturn(role: ManualRole) {
    const chosen = selection[role.tagId];
    if (!chosen || chosen.size === 0 || returning) {
      return;
    }
    setReturning(true);
    try {
      const result = (await faceActions.removeTagFromPhotos(role.tagId, [
        ...chosen,
      ])) as { removed: number };
      toast.success(
        t("manualRolesReturned", {
          count: result.removed,
          rest: Math.max(0, chosen.size - result.removed),
        })
      );
      setSelection((prev) => ({ ...prev, [role.tagId]: new Set() }));
      // 列表数字、标签树、以及"待命名列表"都可能变了
      notifyTagChange();
      const refreshed = (await faceActions.listTagPhotos(role.tagId)) as {
        photos?: RolePhoto[];
      };
      setPhotos((prev) => ({ ...prev, [role.tagId]: refreshed?.photos ?? [] }));
      onRenamed?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setReturning(false);
    }
  }

  if (roles.length === 0) {
    return null;
  }

  /*
   * 自用（2026-10-18 · 会话#9）：**展开 = 进入这个角色的图集**（用户口径）——
   * 「展开之后，整个界面就像进入这个文件夹一样，图片大小和那个合集差不多」。
   * 所以这里不再是"卡片里塞 76px 小格子 + 内部滚动"（又小又卡 ✗），
   * 而是整块换成"文件夹视图"：
   *   · 顶部：← 返回角色列表 · 角色名 · N 张 · 勾选提示 · 已选/清空/退回
   *   · 网格：和合集一致（minmax 190px、gap-4），图片按需加载 + 屏幕外不渲染 ✓
   *   · 滚动交给**页面本身**（不再套一层 max-h 的内部滚动，那个最容易卡）✓
   */
  const expandedRole =
    expandedTagId === null
      ? null
      : (roles.find((role) => role.tagId === expandedTagId) ?? null);

  if (expandedRole) {
    const list = photos[expandedRole.tagId] ?? [];
    const chosen = selection[expandedRole.tagId] ?? new Set<number>();
    const loadingThis = loadingId === expandedRole.tagId;
    return (
      <section
        className={`${enterClass} mb-5`}
        /* key 不同 → 切换时 React 重新挂载，入场动画才会**每次**播放 ✓ */
        key={`album-${expandedRole.tagId}`}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            className="flex items-center gap-1 rounded-[6px] border border-border bg-card px-2.5 py-1.5 text-[12px] text-foreground transition-colors hover:bg-foreground/5"
            onClick={() => setExpandedTagId(null)}
            type="button"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("manualRolesBackToList")}
          </button>
          <span className="min-w-0 truncate font-medium text-[14px] text-foreground">
            {expandedRole.tagName}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t("manualRolesPhotoCount", { count: expandedRole.photoCount })}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t("characterDiscoverySelectHint")}
          </span>
          {chosen.size > 0 && (
            <>
              <span className="text-[11px] text-foreground">
                {t("characterDiscoverySelected", { count: chosen.size })}
              </span>
              <button
                className="text-[11px] text-muted-foreground underline transition-colors hover:text-foreground"
                onClick={() =>
                  setSelection((prev) => ({
                    ...prev,
                    [expandedRole.tagId]: new Set(),
                  }))
                }
                type="button"
              >
                {t("characterDiscoveryClearSelection")}
              </button>
              <button
                className="rounded-[4px] border border-destructive/60 px-2 py-0.5 text-[11px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                disabled={returning}
                onClick={() =>
                  setConfirmReturn({ role: expandedRole, count: chosen.size })
                }
                type="button"
              >
                {returning
                  ? t("manualRolesReturning")
                  : t("manualRolesReturnButton", { count: chosen.size })}
              </button>
            </>
          )}
        </div>

        {loadingThis ? (
          <div className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
            <LoadingSpinner size="sm" />
            {t("characterDiscoveryLoadingPhotos")}
          </div>
        ) : list.length === 0 ? (
          <p className="py-6 text-[12px] text-muted-foreground">
            {t("manualRolesNoPhotos")}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,190px),1fr))] gap-4">
            {list.map((photo, photoIndex) => {
              const isPicked = chosen.has(photo.id);
              return (
                <div
                  className={`relative overflow-hidden rounded-[8px] border bg-card [contain-intrinsic-size:auto_230px] [content-visibility:auto] ${
                    isPicked ? "border-primary" : "border-border"
                  }`}
                  key={photo.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setCoverMenu({
                      photo,
                      tagId: expandedRole.tagId,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <button
                    aria-label={t("characterDiscoveryToggleSelect")}
                    aria-pressed={isPicked}
                    className={`absolute top-1.5 left-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 transition-colors ${
                      isPicked
                        ? "border-primary bg-primary text-white"
                        : "border-white/80 bg-black/35 hover:bg-black/60"
                    }`}
                    onClick={() => toggleSelect(expandedRole.tagId, photo.id)}
                    type="button"
                  >
                    {isPicked && <Check className="h-4 w-4" />}
                  </button>
                  <img
                    alt=""
                    className="aspect-square w-full cursor-zoom-in object-cover"
                    decoding="async"
                    loading="lazy"
                    onClick={() =>
                      setLightbox({ index: photoIndex, photos: list })
                    }
                    src={toLocalMediaUrl(photo.thumbnailPath || photo.path)}
                  />
                </div>
              );
            })}
          </div>
        )}

        {coverMenu && (
          <>
            {/* 点别处关掉菜单 */}
            <button
              aria-label={t("close")}
              className="fixed inset-0 z-[999] cursor-default"
              onClick={() => setCoverMenu(null)}
              type="button"
            />
            <div
              className={`${menuClass} fixed z-[1000] min-w-[160px] overflow-hidden rounded-[8px] border border-border bg-popover p-1 shadow-xl`}
              style={{ left: coverMenu.x, top: coverMenu.y }}
            >
              <button
                className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[12px] text-foreground hover:bg-muted disabled:opacity-50"
                disabled={settingCover}
                onClick={() => void setAsCover()}
                type="button"
              >
                <ImageIcon className="h-3.5 w-3.5" />
                {t("manualRolesSetCover")}
              </button>
            </div>
          </>
        )}

        {lightbox && (
          <PhotoLightbox
            initialIndex={lightbox.index}
            onBackdropClick={() => setLightbox(null)}
            onClose={() => setLightbox(null)}
            open
            photos={lightbox.photos}
          />
        )}
        {confirmReturn && (
          <ConfirmDialog
            confirmText={t("manualRolesReturnConfirm")}
            description={t("manualRolesReturnBody", {
              count: confirmReturn.count,
              name: confirmReturn.role.tagName,
            })}
            destructive
            onCancel={() => setConfirmReturn(null)}
            onConfirm={() => {
              const role = confirmReturn.role;
              setConfirmReturn(null);
              void doReturn(role);
            }}
            open
            title={t("manualRolesReturnTitle")}
          />
        )}
      </section>
    );
  }

  return (
    <section className={`${enterClass} mb-5`} key="roles">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="font-medium text-[13px] text-foreground">
          {t("manualRolesTitle")}
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {t("manualRolesHint")}
        </span>
        <span className="text-[11px] text-muted-foreground/70">
          {t("manualRolesEntryHint")}
        </span>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,190px),1fr))] gap-4">
        {roles.map((role) => {
          const list = photos[role.tagId] ?? [];
          const chosen = selection[role.tagId] ?? new Set<number>();
          const loadingThis = loadingId === role.tagId;
          return (
            <div
              className="overflow-hidden rounded-[10px] border border-border bg-card"
              key={role.tagId}
            >
              <div>
                {/* 封面 + 右上角「展开图集」按钮（未展开时占满卡片宽度） */}
                <div className="relative aspect-square w-full shrink-0 overflow-hidden bg-black/20">
                  {role.thumbnailPath ? (
                    <img
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                      src={toLocalMediaUrl(role.thumbnailPath)}
                    />
                  ) : null}
                  <button
                    className="absolute top-1.5 right-1.5 rounded-[4px] bg-black/55 px-2 py-0.5 text-[11px] text-white backdrop-blur-sm transition-colors hover:bg-black/75"
                    onClick={() => void toggleExpand(role)}
                    type="button"
                  >
                    {t("manualRolesExpand")}
                  </button>
                </div>

              </div>

              {/* 信息行：名字 + 张数 + 改名按钮，一行内**垂直居中**、位置规整 */}
              <div className="flex min-h-[38px] items-center gap-2 p-2">
                {editingId === role.tagId ? (
                  <>
                    <input
                      autoFocus
                      className="min-w-0 flex-1 rounded-[4px] border border-border bg-secondary px-2 py-1 text-[12px] text-foreground outline-none focus:border-foreground/40"
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          void save(role.tagId);
                        } else if (event.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      value={draft}
                    />
                    <button
                      className={BUTTON_CLASS}
                      disabled={saving || draft.trim().length === 0}
                      onClick={() => void save(role.tagId)}
                      type="button"
                    >
                      {t("manualRolesRenameSave")}
                    </button>
                    <button
                      className="shrink-0 rounded-[6px] px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                      onClick={() => setEditingId(null)}
                      type="button"
                    >
                      {t("manualRolesRenameCancel")}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="min-w-0 truncate text-[12px] text-foreground">
                        {role.tagName}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {t("manualRolesPhotoCount", { count: role.photoCount })}
                      </span>
                    </div>
                    <button
                      className={BUTTON_CLASS}
                      onClick={() => {
                        setEditingId(role.tagId);
                        setDraft(role.tagName);
                      }}
                      type="button"
                    >
                      {t("manualRolesRename")}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {lightbox && (
        <PhotoLightbox
          initialIndex={lightbox.index}
          onBackdropClick={() => setLightbox(null)}
          onClose={() => setLightbox(null)}
          open
          photos={lightbox.photos}
        />
      )}

      {confirmReturn && (
        <ConfirmDialog
          confirmText={t("manualRolesReturnConfirm")}
          description={t("manualRolesReturnBody", {
            count: confirmReturn.count,
            name: confirmReturn.role.tagName,
          })}
          destructive
          onCancel={() => setConfirmReturn(null)}
          onConfirm={() => {
            const role = confirmReturn.role;
            setConfirmReturn(null);
            void doReturn(role);
          }}
          open
          title={t("manualRolesReturnTitle")}
        />
      )}
    </section>
  );
}