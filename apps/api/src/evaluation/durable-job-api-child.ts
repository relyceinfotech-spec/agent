import { config } from "../config.js";
import { app } from "../server.js";

await app.listen({ port: config.PORT, host: "127.0.0.1" });
process.stdout.write("api_ready\n");

const stopped = new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});

await stopped;
await app.close();
