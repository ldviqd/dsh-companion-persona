/**
 * 人格时间线：append-only 审计日志。
 *
 * 为什么必须有这个：人格漂变如果不留痕，就和随机波动无法区分 ——
 * 任何时候都应该能回答"它为什么变成这样"。覆盖式重写做不到这一点。
 *
 * 每条变更记录：触发事件类型、前后状态、作用通道（drift/bond/mutation）、
 * 以及**原始用户发言片段**作为证据。这样任何时候都能回答"它为什么变了"。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  } catch {
    // 审计失败不影响主流程
  }
}

