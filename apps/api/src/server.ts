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
import { RateLimiter } from "./rate-limiter.js";

export const rateLimiter = new RateLimiter(
  config.RATE_LIMIT_WINDOW_MS,
  config.RATE_LIMIT_MAX_REQUESTS,
);

export async function createServer() {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
    bodyLimit: config.MAX_BODY_BYTES, // 64KB strict request body limit
  });

  // Strict CORS policy: only configured WEB_URL (and local dev if not production)
  const allowedOrigins = new Set([
    config.WEB_URL,
    ...(config.NODE_ENV !== "production" ? ["http://localhost:3000", "http://127.0.0.1:3000"] : []),
  ]);

  await app.register(cors, {
    origin: (origin, callback) => {
      // Allow non-browser agents or same-origin requests where origin is undefined
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed by CORS policy"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  await app.register(sensible);

  // Security headers on all responses
  app.addHook("onSend", async (_request, reply) => {
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("X-Frame-Options", "DENY");
    void reply.header("X-XSS-Protection", "1; mode=block");
    void reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    if (config.NODE_ENV === "production") {
      void reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  // Rate limiting hook for all /api/ endpoints
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      const clientIp = request.ip || "127.0.0.1";
      const result = rateLimiter.check(clientIp);

      void reply.header("X-RateLimit-Limit", result.limit);
      void reply.header("X-RateLimit-Remaining", result.remaining);

      if (!result.allowed) {
        const retrySec = Math.ceil(result.resetMs / 1000);
        void reply.header("Retry-After", retrySec);
        return reply.code(429).send({
          error: "Too many requests. Please slow down and try again.",
          retryAfterSeconds: retrySec,
        });
      }
    }
  });

  const store = new MemorySessionStore();
  const search = new SearXNGProvider(config.SEARXNG_URL);
  const llm = new OpenRouterProvider();
  const registry = createToolRegistry(search, llm);
  const runner = new ResearchRunner(store, search, llm, registry);
  const agent = new AutonomousAgent(registry, runner, llm, store);

  const requestSchema = z.object({
    question: z.string().trim().min(4).max(2000),
    mode: z.enum(["quick", "deep"]).default("quick"),
  });
  const clarificationSchema = z.object({ answer: z.string().trim().min(1).max(1000) });
  const chatSchema = z.object({
    message: z.string().trim().min(1).max(2000),
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
      search: "connected",
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

  // Sanitized error handler: never leaks stack traces, internal paths, or API keys
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, url: request.url, method: request.method });
    if (reply.sent) return;

    const err = error as { statusCode?: number; message?: string };
    const status = err.statusCode ?? 500;
    if (status === 413) {
      return reply.code(413).send({ error: "Payload exceeds maximum allowed size of 64KB." });
    }
    if (status === 429) {
      return reply.code(429).send({ error: err.message || "Too many requests." });
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message || "Invalid request." });
    }
    return reply
      .code(500)
      .send({ error: "An unexpected server error occurred. Please try again." });
  });

  return app;
}

export const app = await createServer();

if (process.env.NODE_ENV !== "test") {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}
