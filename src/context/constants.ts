/** 上下文压缩相关阈值与默认值 */

export const SINGLE_TOOL_RESULT_TOKENS = 20_000;
export const MESSAGE_TOOL_RESULTS_TOKENS = 40_000;
export const AUTO_RESERVE_TOKENS = 13_000;
export const MANUAL_RESERVE_TOKENS = 3_000;
export const KEEP_RECENT_TOKENS = 10_000;
export const KEEP_RECENT_MIN_MESSAGES = 5;
export const SUMMARY_FAIL_LIMIT = 3;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const CHARS_PER_TOKEN = 4;

/** 工具结果预览保留的字符数 */
export const TOOL_RESULT_PREVIEW_CHARS = 500;

/** 已落盘工具结果的内容标记，避免重复 spill */
export const TOOL_RESULT_SPILL_MARKER = "<!-- mewcode-tool-result-file:";
