// Shared metadata lets independent picker packages unwind wrappers in either order.
const PATCH = Symbol.for("pi.fast-picker.patch.v1");
type Method = (this: any, ...args: any[]) => any;
type Wrapped = Method & { [PATCH]?: { active: boolean; original: Method } };
function unwrap(method: Wrapped): Method {
  while (method[PATCH] && !method[PATCH]!.active) method = method[PATCH]!.original;
  return method;
}
export function installInteractivePatch(
  prototype: any,
  name: string,
  handler: (this: any, original: Method, ...args: any[]) => any,
): () => void {
  const original = prototype[name] as Method;
  if (typeof original !== "function") throw new Error(`Pi interactive contract missing: ${name}`);
  const state = { active: true, original };
  const wrapped: Wrapped = function (...args) {
    return state.active ? handler.call(this, original, ...args) : original.apply(this, args);
  };
  wrapped[PATCH] = state;
  prototype[name] = wrapped;
  return () => {
    state.active = false;
    if (prototype[name] === wrapped) prototype[name] = unwrap(original);
  };
}
