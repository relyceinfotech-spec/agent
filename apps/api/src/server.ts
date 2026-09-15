import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { z } from "zod";
import { config } from "./config.js";
import { ResearchRunner } from "./research.js";
import { SearXNGProvider } from "./search.js";
import { MemorySessionStore } from "./store.js";
import { OpenRouterProvider } from "./llm.js";
import { AutonomousAgent } from "./agent/autonomous.js";
import { createToolRegistry } from "./agent/tools.js";

const app = Fastify({ logger: { level: config.NODE_ENV === "production" ? "info" : "debug" } });
await app.register(cors, { origin: [config.WEB_URL], credentials: true });
await app.register(sensible);

app.addHook("onSend", async (_request, reply) => {
  void reply.header("X-Content-Type-Options", "nosniff");
  void reply.header("X-Frame-Options", "DENY");
  void reply.header("X-XSS-Protection", "1; mode=block");
  void reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

const store = new MemorySessionStore();
const search = new SearXNGProvider(config.SEARXNG_URL);
const llm = new OpenRouterProvider();
const registry = createToolRegistry(search, llm);
const runner = new ResearchRunner(store, search, llm, registry);
const agent = new AutonomousAgent(registry, runner, llm, store);
const requestSchema = z.object({
  question: z.string().trim().min(8).max(2000),
  mode: z.enum(["quick", "deep"]).default("quick"),
});
const clarificationSchema = z.object({ answer: z.string().trim().min(2).max(1000) });
const chatSchema = z.object({
  message: z.string().trim().min(2).max(2000),
  deepResearch: z.boolean().default(false),
});
app.get("/health", async () => ({
  status: "ok",
  service: "research-agent-max-api",
  time: new Date().toISOString(),
}));
app.get("/ready", async (_request, reply) => {
  if (!config.SEARXNG_URL) return reply.serviceUnavailable("SEARXNG_URL is not configured");
  return {
    status: "ready",
    search: config.SEARXNG_URL,
    llm: Boolean(config.OPENROUTER_API_KEY),
    persistence: "memory",
  };
});
app.post("/api/chat", async (request, reply) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(JSON.stringify(parsed.error.flatten()));
  const response = await agent.handle(parsed.data.message, parsed.data.deepResearch);
  return reply.code(response.route === "direct" || response.answer ? 200 : 202).send(response);
});
app.post("/api/research", async (request, reply) => {
  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(JSON.stringify(parsed.error.flatten()));
  const session = await runner.start(parsed.data.question, parsed.data.mode);
  return reply.code(202).send({ id: session.id, status: session.status });
});
app.get("/api/research", async () => store.list());
app.get<{ Params: { id: string } }>("/api/research/:id", async (request, reply) => {
  const session = await store.get(request.params.id);
  return session ? session : reply.notFound("Research session not found");
});
app.post<{ Params: { id: string } }>("/api/research/:id/clarify", async (request, reply) => {
  const parsed = clarificationSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(JSON.stringify(parsed.error.flatten()));
  const session = await runner.resume(request.params.id, parsed.data.answer);
  return session
    ? reply.code(202).send({ id: session.id, status: session.status })
    : reply.notFound("Clarification is not available for this research session");
});
app.post<{ Params: { id: string } }>("/api/research/:id/cancel", async (request, reply) => {
  const session = await runner.cancel(request.params.id);
  return session
    ? reply.code(200).send({ id: session.id, status: session.status })
    : reply.notFound("Research session not found");
});
app.delete<{ Params: { id: string } }>("/api/research/:id", async (request, reply) => {
  await store.delete(request.params.id);
  return reply.code(204).send();
});
app.get<{ Params: { id: string } }>("/api/research/:id/events", async (request, reply) => {
  const session = await store.get(request.params.id);
  if (!session) return reply.notFound("Research session not found");
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": config.WEB_URL,
  });
  const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: "research.snapshot", session });
  const unsubscribe = runner.subscribe(request.params.id, send);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
  request.raw.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
});
app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  if (!reply.sent) void reply.internalServerError("Unexpected server error");
});
await app.listen({ port: config.PORT, host: "0.0.0.0" });
