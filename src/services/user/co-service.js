/**
 * CO User-Level Services — context read interface for the chat layer.
 *
 * Principle 2: Chat agents read from CO, never from WS directly.
 * This thin facade is the stable contract between chat routes and the CO system.
 */
export { getWorkspaceContext as getContext } from "../system/co-system.js";
