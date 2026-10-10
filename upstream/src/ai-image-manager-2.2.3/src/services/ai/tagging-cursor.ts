/**
 * 自用（需求 1）：打标游标"要不要归零"的判定。
 *
 * 背景（一个真实的 bug）：
 *   原来两个 tagger 里的条件是 `options.resetCursor && !isFullRunDone()`，
 *   注释写的是"只在第一次全库重扫时归零，之后中途关掉应用再点一次会从上次的游标继续"。
 *   但 `FULL_RUN_KEY` 只在**完整跑完**时才置位 —— 于是"跑到一半崩溃 / 关软件 / 取消"
 *   之后再点按钮，`isFullRunDone()` 仍是 false，游标被归零，
 *   已经打好的几千张会被**从头重打一遍**。这就是用户报的"建库中途退出后再建库要从头开始"。
 *
 * 现在的规则（两个出口，语义严格分开）：
 *   · **默认（界面上点"生成 AI 标签"）**：调用方传 `resetCursor: false` 或不传 →
 *     **永不归零**，从游标继续。这是"断点续跑"，也是绝大多数情况该走的路。
 *   · **显式要求从头**：调用方传 `resetCursor: true` →
 *     **无条件归零**（`forceResetCursor: true` 语义）。
 *     只有"换模型要把旧标签全部重打"这类明确意图才该这么做，例如无头命令
 *     `--run-pixai-tagging`（它另有 `--tag-resume` 走续跑）。
 *
 * ⚠️ 曾经的坑：把"调用方传了 true"和"只有全新库才该归零"混在一个判定里，
 *    导致"全库重跑"入口在已有游标的库上**静默退化成续跑**（第 10 轮发现并修掉）。
 *    所以 `cursor` / `fullRunDone` 只作为**日志与断言**的输入，不再参与"是否归零"的决策。
 */
export function shouldResetTaggingCursor(
  options: { resetCursor?: boolean },
  state: { cursor: number; fullRunDone: boolean }
): boolean {
  // state 目前不参与决策，但保留参数：调用方（两个 tagger）都在读游标与完成标记，
  // 传进来便于日志与单元测试断言"当时库里是什么状态"。
  void state;
  return options.resetCursor === true;
}
