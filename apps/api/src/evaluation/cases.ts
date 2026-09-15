import type { AgentRoute } from "../agent/autonomous.js";

export interface AgentEvaluationExpectation {
  route: AgentRoute;
  clarification?: boolean;
}

export interface AgentEvaluationCase {
  name: string;
  prompt: string;
  deepResearch?: boolean;
  expect: AgentEvaluationExpectation;
}

/**
 * Stable prompts for evaluating the agent's first decision. These cases test
 * routing behavior, not the wording of the final answer.
 */
export const agentEvaluationCases: AgentEvaluationCase[] = [
  {
    name: "javascript_closure",
    prompt: "Explain JavaScript closures simply.",
    expect: { route: "direct" },
  },
  {
    name: "rest_api",
    prompt: "What is a REST API?",
    expect: { route: "direct" },
  },
  {
    name: "javascript_promises",
    prompt: "How do promises work in JavaScript?",
    expect: { route: "direct" },
  },
  {
    name: "database_indexes",
    prompt: "Explain database indexes for a beginner.",
    expect: { route: "direct" },
  },
  {
    name: "recursion",
    prompt: "What is recursion in programming?",
    expect: { route: "direct" },
  },
  {
    name: "latest_react_version",
    prompt: "What's the latest React version?",
    expect: { route: "web" },
  },
  {
    name: "current_node_lts",
    prompt: "What is the current Node.js LTS version?",
    expect: { route: "web" },
  },
  {
    name: "recent_web_frameworks",
    prompt: "What are the recent developments in web frameworks?",
    expect: { route: "web" },
  },
  {
    name: "current_ai_news",
    prompt: "What are today's major AI news developments?",
    expect: { route: "web" },
  },
  {
    name: "openrouter_changes",
    prompt: "What are the latest OpenRouter API changes?",
    expect: { route: "web" },
  },
  {
    name: "supabase_firebase_comparison",
    prompt: "Compare Supabase and Firebase for my startup.",
    expect: { route: "web" },
  },
  {
    name: "react_native_flutter_comparison",
    prompt: "Compare React Native vs Flutter for a startup.",
    expect: { route: "web" },
  },
  {
    name: "best_backend_language",
    prompt: "What is the best backend language for a startup in 2026?",
    expect: { route: "web" },
  },
  {
    name: "solid_state_battery_investigation",
    prompt: "Investigate the evidence around solid-state batteries.",
    expect: { route: "web" },
  },
  {
    name: "fastapi_node_analysis",
    prompt: "Analyze FastAPI versus Node.js for high-concurrency APIs.",
    expect: { route: "web" },
  },
  {
    name: "react_native_flutter_deep_research",
    prompt: "Deeply compare React Native vs Flutter for a startup in 2026.",
    deepResearch: true,
    expect: { route: "deep" },
  },
  {
    name: "climate_adaptation_deep_research",
    prompt: "Deeply investigate current climate adaptation strategies.",
    deepResearch: true,
    expect: { route: "deep" },
  },
  {
    name: "node_nocodb_ambiguous_comparison",
    prompt: "Is Node better than NocoDB for backend?",
    expect: { route: "web", clarification: true },
  },
  {
    name: "unspecified_production_choice",
    prompt: "Which is better for production?",
    expect: { route: "web", clarification: true },
  },
  {
    name: "messy_react_native_flutter_input",
    prompt: "how react natve perfomance compare fluter 2026",
    expect: { route: "web" },
  },
  {
    name: "messy_javascript_python_ai_input",
    prompt: "is java script faster than pyton for ai",
    expect: { route: "web" },
  },
  {
    name: "performance_benchmark_request",
    prompt: "Benchmark TypeScript and Rust performance for a backend service.",
    expect: { route: "web" },
  },
];
