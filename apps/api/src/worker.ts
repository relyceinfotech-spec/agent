process.env.MAX_WORKER_PROCESS = "1";

const { createServer, getServerBackgroundServices } = await import("./server.js");
const workerApp = await createServer();
const services = getServerBackgroundServices(workerApp);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  services.contentAgent.stopScheduler();
  await services.worker.stop();
  await workerApp.close();
};

const stopped = new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});

services.worker.start();
services.contentAgent.startScheduler();
await stopped;
await shutdown();
