import type { StandardSchemaV1 } from "@standard-schema/spec";

export function schema<Input, Output = Input>(
  validate: StandardSchemaV1.Props<Input, Output>["validate"],
): StandardSchemaV1<Input, Output> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

export const unknownSchema = schema<unknown>((value) => ({ value }));
export const stringSchema = schema<string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected string" }] },
);

export function wire(type: string, payload: unknown, channel = "safe-webview-bridge") {
  return JSON.stringify({ version: 1, channel, type, payload });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
