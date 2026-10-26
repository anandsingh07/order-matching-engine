// Worker entry point. Registers the TypeScript loader inside the worker
// thread, then loads the real entry module named in workerData. A production
// build would compile to JavaScript and skip this step.
import { workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
await import(workerData.entry);
