import type { EventEmitter } from "node:events";

type ShutdownSignalSource = Pick<EventEmitter, "once">;

export function installGracefulShutdown(
  signalSource: ShutdownSignalSource,
  close: () => Promise<unknown>,
  onError: (error: unknown) => void,
): void {
  let shutdown: Promise<unknown> | undefined;

  const beginShutdown = () => {
    shutdown ??= Promise.resolve().then(close).catch(onError);
  };

  signalSource.once("SIGINT", beginShutdown);
  signalSource.once("SIGTERM", beginShutdown);
}
