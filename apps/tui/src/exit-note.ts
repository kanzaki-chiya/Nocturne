/** 退出主屏后打印的恢复提示（ADR-0020）。 */
export function sessionSavedLine(id: string): string {
  return `会话 ${id} 已保存，nctrn -c 继续`;
}
