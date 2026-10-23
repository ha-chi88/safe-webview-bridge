import { failure } from "./result.js";
import type { BridgeError, BridgeLimits, Result } from "./types.js";

type Context = Pick<BridgeError, "phase" | "messageType">;
type Operation = (isActive: () => boolean) => Promise<Result<void>>;
interface Job {
  readonly context: Context;
  readonly operation: Operation;
  readonly resolve: (result: Result<void>) => void;
  readonly cost: number;
}

const error = (context: Context, code: "disposed" | "timeout" | "queue_full") =>
  failure({
    ...context,
    code,
    message: {
      disposed: "Bridge has been disposed",
      timeout: "Bridge operation exceeded processingTimeoutMs",
      queue_full: "Bridge exceeded maxPendingMessages",
    }[code],
  });

export function createQueue(limits: BridgeLimits) {
  const pending: Job[] = [];
  let closed = false;
  let active: { cancel: () => void } | undefined;
  let outstanding = 0;
  let retainedLength = 0;

  const release = (job: Job) => {
    outstanding--;
    retainedLength -= job.cost;
  };

  const pump = () => {
    if (closed || active) return;
    const job = pending.shift();
    if (!job) return;
    let finished = false;
    const deadline = Date.now() + limits.processingTimeoutMs;
    const finish = (result: Result<void>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      active = undefined;
      job.resolve(
        !closed && Date.now() >= deadline ? error(job.context, "timeout") : result,
      );
      pump();
    };
    const timer = setTimeout(
      () => finish(error(job.context, "timeout")),
      limits.processingTimeoutMs,
    );
    active = { cancel: () => finish(error(job.context, "disposed")) };
    // Start on a microtask so callers can register listeners before queued work runs.
    void Promise.resolve()
      .then(() => {
        if (finished || closed) return error(job.context, "disposed");
        return job.operation(() => {
          if (!finished && !closed && Date.now() >= deadline)
            finish(error(job.context, "timeout"));
          return !finished && !closed;
        });
      })
      .then(
        (result) => {
          release(job);
          finish(result);
        },
        (cause: unknown) => {
          release(job);
          finish(
            failure({
              ...job.context,
              code: job.context.phase === "send" ? "transport_failed" : "handler_failed",
              message: "Bridge operation threw unexpectedly",
              cause,
            }),
          );
        },
      );
  };

  return {
    run(context: Context, cost: number, operation: Operation): Promise<Result<void>> {
      if (closed) return Promise.resolve(error(context, "disposed"));
      if (
        outstanding >= limits.maxPendingMessages ||
        cost > limits.maxPendingMessageLength - retainedLength
      ) {
        return Promise.resolve(error(context, "queue_full"));
      }
      return new Promise((resolve) => {
        outstanding++;
        retainedLength += cost;
        pending.push({ context, operation, resolve, cost });
        pump();
      });
    },
    dispose() {
      closed = true;
      for (const job of pending.splice(0)) {
        release(job);
        job.resolve(error(job.context, "disposed"));
      }
      active?.cancel();
    },
  };
}
