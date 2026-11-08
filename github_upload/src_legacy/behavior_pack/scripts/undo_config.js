/**
 * 撤销历史保留设置。
 * 修改后退出世界再进，或重新导入行为包即可生效。
 *
 * mode:
 *   "time"  —— 按时间保留，读取 retentionMinutes
 *   "steps" —— 按步数保留，读取 maxSteps
 *
 * 只会使用当前 mode 对应的那一项。
 */
export const UNDO_CONFIG = {
  mode: "time",
  retentionMinutes: 5,
  maxSteps: 30,
};
