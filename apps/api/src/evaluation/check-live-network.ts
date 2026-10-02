import { config } from "../config.js";
import { checkLiveNetwork } from "./live-network-check.js";

const result = await checkLiveNetwork({
  supabaseUrl: config.SUPABASE_URL,
  openRouterBaseUrl: config.OPENROUTER_BASE_URL,
  requiredConfiguration: [
    { name: "SUPABASE_URL", configured: Boolean(config.SUPABASE_URL) },
    { name: "SUPABASE_SECRET_KEY", configured: Boolean(config.SUPABASE_SECRET_KEY) },
    { name: "SUPABASE_PUBLISHABLE_KEY", configured: Boolean(config.SUPABASE_PUBLISHABLE_KEY) },
    { name: "SERPER_API_KEY", configured: Boolean(config.SERPER_API_KEY) },
    { name: "OPENROUTER_API_KEY", configured: Boolean(config.OPENROUTER_API_KEY) },
    { name: "MEMORY_ENABLED", configured: config.MEMORY_ENABLED },
  ],
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ready) process.exitCode = 1;
