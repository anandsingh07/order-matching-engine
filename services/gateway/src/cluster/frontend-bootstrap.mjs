// Front-end process entry point (see pool.ts). Registers the TypeScript
// loader, then loads the real entry module, as the exchange's worker
// bootstrap does. A production build would compile to JavaScript and skip
// this step.
import { register } from "tsx/esm/api";

register();
await import("./frontend.ts");
