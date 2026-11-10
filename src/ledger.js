/**
 * 人格时间线：append-only 审计日志。
 *
 * 为什么必须有这个：人格漂变如果不留痕，就和随机波动无法区分 ——
 * 任何时候都应该能回答"它为什么变成这样"。覆盖式重写做不到这一点。
 *
 * 每条变更记录：触发事件类型、前后状态、作用通道（drift/bond/mutation）、
 * 以及**原始用户发言片段**作为证据。这样任何时候都能回答"它为什么变了"。
 *
 * ## 轮转（v0.10.3 新增）
 *
 * 早先只 append 不轮转。实测每轮一条记录约 350 字节，
 * 一天 200 轮约 70 KB，一年约 25 MB —— 不算大，但会一直涨，
 * 而且全是历史数据，读起来越来越慢。
 *
 * 策略：
 *   - 单文件超过 MAX_BYTES（2 MB）时轮转
 *   - 轮转后保留 ROTATE_KEEP 份（ledger.jsonl.1 / .2），最老的丢弃
 *   - 每 CHECK_EVERY 次 append 才 stat 一次，避免每次写都查文件大小
 *
 * 2 MB ≈ 5700 条记录（约一个月重度使用），保留 2 份即最多 6 MB。
 */

import { appendFile, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 单文件上限：2 MB */
export const MAX_BYTES = 2 * 1024 * 1024;
/** 保留的历史份数（不含当前文件） */
export const ROTATE_KEEP = 2;
/** 每 N 次写入才检查一次大小 */
const CHECK_EVERY = 20;

let appendCount = 0;

/**
 * 轮转：ledger.jsonl → .1 → .2，最老的丢弃。
 *
 * 失败不抛 —— 轮转是维护动作，不该影响审计写入本身。
 */
async function rotateIfNeeded(file) {
  let size;
  try {
    size = (await stat(file)).size;
  } catch {
    return; // 文件还不存在
  }
  if (size < MAX_BYTES) return;

  try {
    // 从最老的开始往后挪，避免覆盖
    await unlink(`${file}.${ROTATE_KEEP}`).catch(() => {});
    for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
      await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
    }
    await rename(file, `${file}.1`);
  } catch {
    // 轮转失败就继续写当前文件，下次再试
  }
}

/**
 * 追加一条审计记录。失败不抛（审计不该阻断对话）。
 *
 * @param {string} file ledger.jsonl 路径
 * @param {object} record 记录内容
 */
export async function appendLedger(file, record) {
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');

    // 周期性检查大小，而不是每次 stat
    appendCount += 1;
    if (appendCount % CHECK_EVERY === 0) {
      await rotateIfNeeded(file);
    }
  } catch {
    // 审计失败不影响主流程
  }
}

/** 供测试与面板使用：手动触发一次轮转检查 */
export async function checkRotation(file) {
  await rotateIfNeeded(file);
}
