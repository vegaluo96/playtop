/**
 * 安全对象路径取值:沿 path 逐层下钻,任一层非对象则返回 undefined。
 * 全站唯一来源(此前在 20+ 文件各自复制,现集中于此)。
 */
export function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}
