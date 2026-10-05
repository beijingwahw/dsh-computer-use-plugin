/** PhysicalErrorKind 运行时值（声明合并：const + type 同名，TS 支持） */
export const PhysicalErrorKind = {
    INVALID_ARGS: 'invalid_args',
    OUT_OF_BOUNDS: 'out_of_bounds',
    UNKNOWN_BUTTON: 'unknown_button',
    UNKNOWN_KEY: 'unknown_key',
    ELEMENT_NOT_FOUND: 'element_not_found',
    SCREEN_CAPTURE_FAILED: 'screen_capture_failed',
    OCR_UNAVAILABLE: 'ocr_unavailable',
    VLM_UNAVAILABLE: 'vlm_unavailable',
    ACTION_TIMEOUT: 'action_timeout',
    WINDOW_UNAVAILABLE: 'window_unavailable',
    UNAUTHORIZED: 'unauthorized',
    INTERNAL_ERROR: 'internal_error',
    // ΠΑΝ-128: 与 Python 端 errors.py ErrorKind 闭集对齐（additive —— 旧 kind 语义不变）
    DEVICE_UNREACHABLE: 'device_unreachable',
    BUSY: 'busy',
    TRANSPORT_ERROR: 'transport_error',
    CLIENT_TIMEOUT: 'client_timeout',
};
export const ALL_CAPS = [
    'click', 'type', 'scroll', 'hotkey', 'drag',
    'screenshot', 'ui_tree', 'switch_window', 'shm_delete',
    // ΠΑΝ-128: 与 Python auth.ALL_CAPS 闭集同源镜像（程序化对账：test/pan128.capContract.test.ts）
    'admin', 'observe',
];
