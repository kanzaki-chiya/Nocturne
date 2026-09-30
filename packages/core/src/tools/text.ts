/** read 与用户文件引用共用的二进制嗅探规则。 */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}
