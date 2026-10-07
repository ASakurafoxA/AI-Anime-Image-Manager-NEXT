/**
 * 自用精简版开关（private build switches）
 *
 * 用途：把上游 AI Image Manager v2.2.3 里"用不上"的界面入口隐藏掉。
 *
 * 设计原则：
 *  1. **只隐藏入口，不删除代码**。所有页面/组件/后端逻辑/数据库表都保持原样，
 *     因此不会产生悬空路由引用，改动可完全逆转。
 *  2. **集中控制**。想恢复任何一项，把对应的值改成 false 即可，
 *     不需要回头去找散落各处的 JSX。
 *  3. 与上游 v2.2.3 的差异全部由本文件 + 引用它的 6 个文件构成，
 *     便于将来把改动移植到新的上游版本（见 docs/改动记录.md）。
 *
 * 对应的用户决策：
 *  - 去掉「数据仪表盘」「相册」「选片」三个整页面的入口
 *  - 去掉设置页里的：插件 / 漫游 / 序列识别 / 云存储与上传 / 水印设置 / 软件更新
 *  - 纯本地使用，不要云同步 / 云上传 / 分享
 */
/**
 * 自用版显示名称。
 *
 * ⚠️ 名称演进：`AI Anime Image Manager`（本地版）→ `… LAN`（加局域网那版）
 *    → **`… NEXT`**（本版：局域网 + PixAI Tagger v1.0，功能最全）。名字不同是
 *    为了在开始菜单 / 任务栏 / 安装列表里一眼区分开这三个版本。
 *
 * ⚠️ 改名**不会**改变数据目录：`main.ts` 里显式把 `userData` 钉在旧的
 *    `%APPDATA%\AI Anime Image Manager`（见那里的注释）。否则 `productName`
 *    一变，`app.getPath("userData")` 就会指向一个新目录，用户的图库位置、
 *    标签、局域网口令会**全部看起来丢失**。
 */
export const APP_DISPLAY_NAME = "AI Anime Image Manager NEXT";

export const PRIVATE_BUILD = {
  /** 隐藏左侧主导航与命令面板里的「数据仪表盘」入口 */
  hideDashboard: true,

  /** 隐藏「相册」入口（含拖拽照片到侧边栏触发加入相册） */
  hideAlbums: true,

  /** 隐藏「选片」入口（含选中照片后的「开始选片」按钮） */
  hideCull: true,

  /**
   * 隐藏云相关入口：云同步设置页、选中照片后的「上传到云」、右键菜单里的
   * 「上传到云」、以及「生成分享页」。纯本机使用，不需要上传。
   */
  hideCloud: true,

  /** 隐藏侧边栏底部的"有更新"按钮（它的目标设置页已隐藏，避免死链） */
  hideUpdateBadge: true,

  /**
   * 隐藏搜索栏的「EXIF 筛选」面板（漏斗按钮），以及面板里的
   * 日期范围 / 拍摄月份 / 拍摄时段 / 相机 / 镜头 / 创作者 / 高级摄影元数据 等筛选。
   *
   * 说明：这些筛选全都依赖 EXIF 数据。动漫/插画图库基本没有相机 EXIF，
   * 实测本机 79,777 张里 42,042 张完全没有 EXIF，所以这些筛选本来就筛不出东西。
   */
  hideExifFilter: true,

  /**
   * 停止 EXIF「识别」（解析）：
   *  - 导入新照片时不再解析 EXIF
   *  - 不再执行「高级摄影元数据」后台补全
   *
   * 为什么可以关：
   *  1. 动漫插画没有相机 EXIF，这些数据对检索没有价值；
   *  2. 上游对「无 EXIF」的图片会为每张打 2 条 warn 日志，实测 1 小时 45 分
   *     产生 13,686 条，5 MB 日志只够记 4 分钟 —— 这正是交接文档里的 BUG-2；
   *  3. 上游的「序列自动分组」刻意要求**完整 EXIF**（时间+设备+phash），
   *     没有 EXIF 时本来就不会分组，所以关掉不会损失现有可用功能。
   *
   * 注意：**已有的 EXIF 数据不会删除**，只是不再新增。此开关可随时改回 false。
   */
  disableExifExtraction: true,

  /**
   * 关闭上游自动更新检查。
   *
   * 本版是自用分支，且已改名为 AI Anime Image Manager。若继续检查
   * `Uyoung666/ai-image-manager` 的发布，可能提示"有新版本"并下载上游安装包，
   * 从而**覆盖掉全部自用改造**。自用版不需要上游更新。
   */
  disableUpstreamUpdate: true,

  /**
   * 只给"树根"文件夹建 chokidar 监听器。
   *
   * 上游给**每一个**文件夹都建监听器（本机实测 4,414 个），而每个都带 `depth: 10` ——
   * 父目录的监听器已经覆盖整棵子树，于是同一个文件的新增事件会被多个祖先监听器重复上报
   * （靠 alreadyIndexed 查重挡住，不会重复索引，但白做多次查询），并占用大量目录句柄。
   *
   * 已实测验证（同一 chokidar 5.0.0 与相同参数）：只监听根目录同样能收到
   * 第 1/2/3 层子目录的新增事件 → 行为等价，监听器 4,414 → 2。
   */
  watchRootsOnly: true,

  /**
   * 开机增量补扫。
   *
   * 为什么需要：chokidar 配了 `ignoreInitial: true`，监听器**启动时忽略已存在的文件**，
   * 只报告启动后发生的变化；而代码里没有任何开机补扫机制（上游注释明确写着
   * "never rescan every library on startup"）。
   * 本版用户习惯**直接往目录里存图**（不走导入对话框），关机期间存的图因此永远不会入库。
   *
   * 实现：开机后延迟一段时间，对每个树根调用现成的导入队列（enqueueImport），
   * 复用既有的增量扫描 + 进度显示 + AI 后续处理。扫描本身是幂等的，不会重复入库。
   */
  startupCatchUpScan: true,

  /**
   * 软件**运行中**新增的文件，索引完成后自动触发 AI 处理（嵌入 + 打标）。
   *
   * 为什么需要：上游只有在「手动点开始 AI 索引 / 导入队列任务完成 / 向量库损坏自修复」
   * 这三种情况下才会跑 `embedAllPhotos()`；而 chokidar 监听器路径只做索引，
   * 不触发 AI（见 `indexer.ts` 中 "Auto-tagging now runs after embedAllPhotos()
   * completes" 的注释）。结果是：**软件开着时存进来的图，看得见但搜不到、没有标签**。
   *
   * 开启后：监听器收录新文件 → 防抖 30 秒（避免连续存图时反复启动）→
   * 调 `embedAllPhotos()`，它只处理未嵌入的照片，并在结尾自动接上打标。
   */
  autoAiForWatchedFiles: true,

  /**
   * 启用 WD14 动漫 tagger（替代原本基于 SigLIP 的 153 个英文概念标签）。
   *
   * 为什么换：上游的标签是**真人摄影概念**（猫咪 / 宠物 / 婴儿 / 花卉 / 晴朗 …），
   * 套在动漫插画上产生的是"猫咪 42,632 张""婴儿 34,794 张"这类噪声。
   * WD14 是 Danbooru 原生标签体系（10,861 个：角色 2,751 + 通用 8,106 + 分级 4）。
   *
   * 实测（68 张真实测试图）：角色命中 41%、通用标签 100% 命中、0.23 秒/张。
   *
   * 关闭此项会退回上游的 SigLIP 打标行为。
   */
  useWd14Tagger: true,

  /**
   * 隐藏「AI 标签」相关的界面提示，共两处：
   *  1. 缩略图右上角的「AI 标签」角标（按标签筛选时，自动标签命中的图会显示）
   *  2. 标签树底部的说明文字「AI 标签由本地模型自动生成，仅供辅助参考」
   *
   * 自用版里标签已经是本地 WD14 模型的正式产物、不再是"仅供参考的辅助结果"，
   * 所以这两处提示只增加视觉噪声。
   */
  hideAiTagUi: true,

  /**
   * 「以图搜图」优先使用 WD14 的 768 维动漫特征（而不是 SigLIP 的通用图像特征）。
   *
   * 实测区分"同一个角色"的能力（同角色相似度 − 随机对中位）：
   *   SigLIP 768 维 +0.056  ／  WD14 768 维 **+0.149**（约 2.7 倍）
   *
   * 特征表还没有数据、或 WD14 worker 不可用时，会**自动回退**到原来的 SigLIP 路径，
   * 所以开启它不会让"以图搜图"整体失效。
   */
  useWd14ImageSearch: true,

  /**
   * 删除照片时，**把原文件移动进应用自己的回收站**（而不是只做软删除）。
   *
   * 为什么不用 Windows 回收站：系统回收站容易被别的清理工具一起清空。
   * 本版移到 `<dataPath>/回收站/`，文件名 `<photoId>_<原文件名>`，
   * **从删除时刻算起保留 30 天**，之后启动时自动清理。
   *
   * ⚠️ 移动失败时**不会删除库记录** —— 避免"库里没了、文件还在原地"的不一致。
   * 本版**不提供**"彻底删除"按钮：想立刻清空，直接去删那个目录即可。
   */
  moveDeletedFilesToAppTrash: true,

  /**
   * 照片右键菜单精简：
   *  · 去掉「导出」和「添加到相册」（自用版不用这两个入口）
   *  · 多选时只保留「收藏」和「删除」（相册/封面类项一律隐藏）
   */
  hidePhotoMenuExtras: true,

  /**
   * 隐藏主界面的「序列」功能（自用版用不上连拍/同组序列）。
   *
   * 做法是**最小侵入**：把浏览模式强制成「照片」并隐藏切换入口，
   * 于是所有 `sequenceMode === "sequences"` 的分支自然失效 ——
   * 底层代码（sequences.ts / 序列检测）全部保留，随时可恢复。
   */
  hideSequenceUi: true,

  /**
   * 「关于」页面精简：
   *  · 去掉「灵感切片」图片轮播
   *  · 去掉「开源依赖」下面那部分（致谢文字 + 播放人群动画开关 + 人群动画）
   * 保留：作者、GitHub 项目主页、开源依赖列表。
   */
  hideAboutExtras: true,

  /**
   * 关闭启动时「发现 N 个待反馈故障」的提示横幅。
   *
   * 那个横幅来源于「帮助与诊断」功能（`/settings/diagnostics` 已在 hiddenSettingsRoutes 里隐藏）。
   * 但横幅是 __root.tsx 里的全局 toast，不随设置页隐藏 —— 对自用版来说只是噪声。
   *
   * 注意：这里只是**不弹提示**，故障仍然会被记录（diagnostics/incidents.jsonl），
   * 需要时依然可以从「帮助与诊断」页面查看。
   */
  hideDiagnosticsNotice: true,

  /**
   * 自用版：整体停用「帮助与诊断」功能（设置 → 帮助与诊断）。
   *
   * 停用后该页面只显示一句说明：不再列出待反馈故障、也不能生成反馈报告。
   * 故障仍会记进本地 `diagnostics/incidents.jsonl`，需要时直接看文件即可。
   * 崩溃时的致命错误对话框不受影响（那种情况仍然能直接生成报告）。
   */
  disableDiagnostics: true,

  /**
   * 搜索界面精简（与本地工作区保持一致，见根目录「需跟进到局域网工作区的改动.md」）：
   *  · 去掉「试试这样搜索」引导区（标题 + 说明 + 4 个示例词 + 通配符说明）
   *  · 去掉搜索框里带示例的 placeholder（换成朴素的「搜索」）
   * **保留**：日期快捷筛选（今天/本周/…）、标签建议、最近搜索。
   */
  hideSearchHints: true,

  /**
   * 是否采集**通用标签**（服装 / 动作 / 发色 / 构图 / 场景 …）。
   *
   * - true ：每张图约 20–60 个标签，可按"和服""双马尾""仰视"等检索；
   *          代价是 photo_tags 会到 80 万–320 万行（`getTags` 已做过性能下推）。
   * - false：只采集角色标签（每张约 2–3 个），photo_tags 约 16–24 万行。
   *
   * 用户已选择 true（要通用标签）。
   */
  tagGeneralTags: true,

  /**
   * 是否把 WD14 的 768 维动漫特征存进向量库，用于升级「以图搜图」。
   *
   * 实测这三种特征对"同一角色"的区分力（同角色相似度 − 随机对中位）：
   *   SFace 128 维（真人脸）: −0.048  ❌ 比随机还差
   *   SigLIP 768 维（通用）  : +0.056  ⚠️ 有信号但重叠大
   *   WD14  768 维（动漫）   : +0.149  ✅ 区分度是 SigLIP 的 2.7 倍
   *
   * 特征与标签是**同一次推理的两个输出**，所以采集它不增加任何推理成本。
   */
  storeWd14Embeddings: true,

  /**
   * 打标模型：**PixAI Tagger v1.0**（NEXT 版，2026-10 起默认，替换 WD14）。
   *
   * true  = PixAI：六分类（通用 / 角色 / 作品系列 / 画风 / 元信息 / 分级）、
   *         **保留分级**（rating:s/g/q/e）、1024 维特征、词表 **30,877** 个；
   *         实测 NSFW 角色命中率 30%（WD14 只有 10%），并新增作品系列/画风/分级三个维度。
   * false = 回到 WD14：13 细分类、**丢弃分级**、768 维特征、词表 10,861 个。
   *
   * ⚠️ 两个模型的数据**互不通用**（词表不同、特征维度 1024 vs 768），所以：
   *    · 向量库各用各的表（`pixai_embeddings` / `wd14_embeddings`）；
   *    · 切换开关后**必须重跑一次全库打标**，否则以图搜图会用错维度的特征。
   *
   * ⚠️ 速度差很多：PixAI 在 CPU 上约 **6.5 秒/张**（WD14 约 0.23 秒），
   *    所以 PixAI 的 worker 默认尝试 DirectML（见 `pixai-tagger-client.ts`）。
   */
  usePixaiTagger: true,

  /**
   * 是否把 PixAI 的 1024 维动漫特征存进向量库，用于「以图搜图」。
   * 与 `storeWd14Embeddings` 同义（特征与标签是同一次推理的两个输出，不增加推理成本）。
   */
  storePixaiEmbeddings: true,

  /**
   * 局域网访问（自用新增，见工作区根目录「局域网功能实施计划.md」）。
   *
   * true  = 设置页出现「局域网访问」一节，可以开启 0.0.0.0 监听、配置端口与双口令；
   * false = 整个功能不可达（设置页不显示该节），监听地址恒为 127.0.0.1。
   *
   * ⚠️ 这是**总开关，不是"允许开关"**：即使这里为 true，也必须同时满足
   * 「用户在设置页开启 + 已设置永久口令」才会真正监听局域网
   * （见 `src/services/lan-access.ts` 的 `shouldListenOnLan()`）。
   *
   * ⚠️ 出问题时的第一处理办法就是把这里改成 false 并重启：
   * 重启后只监听 127.0.0.1，局域网设备立刻访问不到。
   */
  enableLanAccess: true,

  /**
   * 设置页里要隐藏的路由。这些路由文件与后端逻辑全部保留，
   * 只是不再出现在设置页导航和设置项搜索里。
   */
  /**
   * 自用精简：去掉「导出选中照片」的全部入口
   * （选择工具栏按钮、Ctrl+Shift+E、快捷键面板那一行）。
   */
  slimExportAction: true,

  /** 自用精简：去掉「格式转换选中照片」的全部入口（工具栏、Ctrl+Shift+C、面板行）。 */
  slimConvertAction: true,

  /** 自用精简：去掉详情面板的 I 快捷键与面板行（面板本体与鼠标切换保留）。 */
  slimDetailShortcut: true,

  /**
   * 自用精简：去掉「界面」段的 6 个快捷键（[ / Ctrl+F / Ctrl+K / ? /
   * Ctrl+Shift+F / Ctrl+Shift+H）及面板对应 6 行；主进程也不再注册后两个。
   * 窗口常规关闭/最小化/托盘不受影响。
   */
  slimWindowShortcuts: true,

  /** 自用精简：去掉大图模式的幻灯片（Space、菜单里的播放项、面板行）。 */
  slimLightboxSlideshow: true,

  /** 自用精简：去掉大图模式的旋转（R/Shift+R）与缩放模式（0/1）的快捷键、面板行与按钮。 */
  slimLightboxViewControls: true,

  hiddenSettingsRoutes: [
    "/settings/plugins",
    "/settings/wander",
    "/settings/sequences",
    "/settings/cloud-sync",
    "/settings/watermark",
    "/settings/update",
    "/settings/diagnostics",
  ],
} as const;

/**
 * 当前生效的打标器。
 *
 * ⚠️ 分派点只应该问这个函数，不要在调用处散着写 `if (PRIVATE_BUILD.usePixaiTagger)` ——
 *    打标的分派原本散在 6 个地方（embedder / search / ipc ai handler / 两个 worker client），
 *    再散着加一处 PixAI 判断，早晚会出现"一半走 PixAI、一半走 WD14"的错配。
 */
export function getActiveTagger(): "pixai" | "wd14" | "upstream" {
  if (PRIVATE_BUILD.usePixaiTagger) {
    return "pixai";
  }
  if (PRIVATE_BUILD.useWd14Tagger) {
    return "wd14";
  }
  return "upstream";
}

/** 供设置页导航使用：判断某个设置路由是否应被隐藏。 */
const HIDDEN_SETTINGS_ROUTE_SET = new Set<string>(
  PRIVATE_BUILD.hiddenSettingsRoutes
);

export function isSettingsRouteHidden(to: string): boolean {
  return HIDDEN_SETTINGS_ROUTE_SET.has(to);
}

/** 供命令面板（Spotlight）使用：判断某个导航项 id 是否应被隐藏。 */
export function isSpotlightNavItemHidden(id: string): boolean {
  if (PRIVATE_BUILD.hideDashboard && id === "nav-dashboard") {
    return true;
  }
  if (PRIVATE_BUILD.hideAlbums && id === "nav-albums") {
    return true;
  }
  if (PRIVATE_BUILD.hideCull && id === "nav-cull") {
    return true;
  }
  return false;
}
