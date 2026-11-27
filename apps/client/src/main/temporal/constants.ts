/**
 * Engineering values for the node workflows (DECISIONS "Temporal in the node (2026-11-26)"). None
 * is a business rule. Plain constants, so workflow code and Node code can both import them.
 */

/** Heartbeat timeout of the run step: how soon the run of a killed worker is retried elsewhere. */
export const RUN_HEARTBEAT_TIMEOUT_S = 10;

/** Bundle checks continue as new once history passes this many events (the example .henge uses 400). */
export const CONTINUE_AS_NEW_AFTER_EVENTS = 400;

/** Default time between bundle update checks; the caller may pass another. */
export const BUNDLE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Temporal namespace and task queue of the local node. */
export const NODE_NAMESPACE = 'henge';
export const NODE_TASK_QUEUE = 'henge-node';
