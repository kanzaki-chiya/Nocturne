/** 已按终端显示宽度排好的活动区行。 */
export interface LineSegment {
  text: string;
  color?: string | undefined;
  backgroundColor?: string | undefined;
  dim?: boolean | undefined;
  bold?: boolean | undefined;
}

export interface LaidLine {
  key: string;
  text: string;
  color?: string | undefined;
  dim?: boolean | undefined;
  bold?: boolean | undefined;
  segments?: readonly LineSegment[] | undefined;
}
