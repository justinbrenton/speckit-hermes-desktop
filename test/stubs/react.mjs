/** React hook stand-ins: enough for module evaluation, not for rendering. */
export const useState = initial => [typeof initial === 'function' ? initial() : initial, () => {}]
export const useEffect = () => {}
export const useMemo = factory => factory()
export const useRef = value => ({ current: value })
export const useCallback = fn => fn
