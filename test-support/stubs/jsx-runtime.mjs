/** Records the element tree instead of rendering it. */
export const jsx = (type, props) => ({ type, props: props || {} })
export const jsxs = (type, props) => ({ type, props: props || {} })
export const Fragment = Symbol('Fragment')
