/**
 * Domain configuration for the Video Context Graph
 */

export const DOMAIN = {
  id: "video-context-graph",
  name: "Delta Learning",
  description:
    "A personalized study workspace that shows what is new to you, not just what is in a video.",
  tagline: "Learn the difference",
};

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

export const NODE_COLORS: Record<string, string> = {
  Video: "#8b5cf6",
  Segment: "#0ea5e9",
  Entity: "#f59e0b",
  Topic: "#10b981",
  Person: "#22c55e",
  Organization: "#3b82f6",
  Location: "#a855f7",
  Object: "#eab308",
  Concept: "#22c55e", // viewer knowledge; status-based override in ContextGraphView
};

// Concept nodes color by knowledge status, not label — applied in ContextGraphView.
export const CONCEPT_STATUS_COLORS: Record<string, string> = {
  known: "#22c55e", // green — already in the knowledge base
  goal: "#3b82f6", // blue — explicitly wants to learn
};

export const NODE_SIZES: Record<string, number> = {
  Video: 34,
  Segment: 20,
  Entity: 22,
  Topic: 22,
};

export const DEFAULT_CYPHER = `MATCH (v:Video)-[r:HAS_SEGMENT]->(s:Segment) RETURN v, r, s LIMIT 100`;

export const SCHEMA_NODE_SIZE = 30;
export const SCHEMA_REL_COLOR = "#94a3b8";

export interface GraphData {
  results: Record<string, unknown>[];
}

export interface DemoScenario {
  name: string;
  prompts: string[];
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    name: "Plan",
    prompts: [
      "What should I watch in the L8 agentic engineering talk?",
      "Which talk gives me the shortest useful study session?",
    ],
  },
  {
    name: "Learn",
    prompts: [
      "What parts of the Postgres talk are new to me?",
      "Which videos advance my game theory goal?",
    ],
  },
  {
    name: "Connect",
    prompts: [
      "Show the concepts I already know and what I want to learn",
      "How does this talk connect to my saved notes?",
    ],
  },
];
