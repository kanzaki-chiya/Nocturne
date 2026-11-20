export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const INITIAL_FIT_WIDTH_MAX_SCALE = 1.25;
export const SPREADSHEET_INITIAL_MIN_SCALE = 1;

const STAGE_FIT_WIDTH_GUTTER_PX = 36;
const MIN_AVAILABLE_WIDTH_PX = 160;
const SPREADSHEET_EXT_RE = /\.(xlsx|xls|ods)$/i;

export interface FitWidthBounds {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

export function isSpreadsheetDocument(fileNameOrPath: string): boolean {
  return SPREADSHEET_EXT_RE.test(fileNameOrPath.trim());
}

export function getInitialFitWidthBounds(fileNameOrPath: string): {
  readonly min: number;
  readonly max: number;
} {
  return isSpreadsheetDocument(fileNameOrPath)
    ? { min: SPREADSHEET_INITIAL_MIN_SCALE, max: INITIAL_FIT_WIDTH_MAX_SCALE }
    : { min: MIN_SCALE, max: INITIAL_FIT_WIDTH_MAX_SCALE };
}

export function computeFitWidthScale(
  pageWidth: number,
  stageClientWidth: number,
  bounds: FitWidthBounds = {},
): number {
  const minScale = bounds.min ?? MIN_SCALE;
  const maxScale = bounds.max ?? MAX_SCALE;
  const available = Math.max(MIN_AVAILABLE_WIDTH_PX, stageClientWidth - STAGE_FIT_WIDTH_GUTTER_PX);
  const raw = available / Math.max(1, pageWidth);
  return Math.max(minScale, Math.min(maxScale, raw));
}
