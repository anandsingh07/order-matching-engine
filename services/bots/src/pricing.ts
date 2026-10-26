// @ome/pricing is not a declared dependency of this package yet: adding one
// needs a lockfile update (`pnpm install`). Until then it is imported by path,
// and this file is the only place that knows; afterwards it becomes
// `export * from "@ome/pricing";`.
export * from "../../../packages/pricing/src/index.ts";
