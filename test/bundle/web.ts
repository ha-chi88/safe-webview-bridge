import { createWebBridge } from "../../src/web.js";
import type { Contract } from "./contract.js";
import { toWeb } from "./to-web.js";

export const bridge = createWebBridge<Contract>({ receive: toWeb });
