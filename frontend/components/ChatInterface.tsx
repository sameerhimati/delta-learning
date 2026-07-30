"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Box, Flex, Text, Textarea, IconButton, VStack, HStack,
  Badge, Button, Spinner, Skeleton, Collapsible, Timeline, Grid,
} from "@chakra-ui/react";
import {
  ArrowUpRight,
  Send,
  RotateCcw,
  ChevronDown,
  Wrench,
  Check,
  Plus,
  X,
  Square,
  Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { API_BASE, DEMO_SCENARIOS, DOMAIN } from "@/lib/config";
import type { GraphData } from "@/lib/config";

interface ToolCall {
  name: string;
  inputs: Record<string, unknown>;
  output_preview: string;
  status: "running" | "complete";
  graph_data?: GraphData;
}

interface ExtractedEntity {
  name: string;
  type: string;
  subtype?: string;
}

interface DetectedPreference {
  category: string;
  preference: string;
  confidence?: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  retryInput?: string;
  entities?: ExtractedEntity[];
  preferences?: DetectedPreference[];
}

interface ChatInterfaceProps {
  onGraphUpdate?: (data: GraphData) => void;
  externalInput?: string | null;
  onExternalInputConsumed?: () => void;
}

const STORAGE_KEY = `ccg-chat-history-${DOMAIN.id}`;
const SESSION_KEY = `ccg-session-id-${DOMAIN.id}`;
// v2 holds every thread in one record. The v1 keys above are still read once,
// to migrate an open tab's history, and then never consulted again.
const THREADS_KEY = `ccg-chat-v2-${DOMAIN.id}`;

interface Thread {
  id: string;
  title: string; // "" until named; the tab falls back to "Untitled"
  sessionId: string | null; // the backend keys agent memory on this, one per thread
  messages: Message[];
  createdAt: number;
  unread: boolean; // an answer landed here while another tab was in front
}

interface PersistedChat {
  v: 2;
  activeId: string;
  threads: Thread[];
}

const NO_MESSAGES: Message[] = [];

function newThread(title = ""): Thread {
  return {
    id: crypto.randomUUID(),
    title,
    sessionId: null,
    messages: [],
    createdAt: Date.now(),
    unread: false,
  };
}

// A tab is ~130px of text. Strip the question stem so the subject — the part
// that tells two tabs apart — survives, then cut once and let the tooltip
// carry the rest. Capitalisation is never altered.
const TITLE_STEM =
  /^\s*(tell me about|what parts of|what should i|what is|what are|what's|which|how does|how do|show the|show me|explain)\s+/i;

function deriveTitle(text: string): string {
  const stripped = text
    .replace(TITLE_STEM, "")
    .replace(/^the\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/, "")
    .trim();
  if (!stripped) return "";
  if (stripped.length <= 22) return stripped;
  const cut = stripped.slice(0, 22);
  const space = cut.lastIndexOf(" ");
  return `${(space > 10 ? cut.slice(0, space) : cut).trim()}…`;
}

function loadThreads(): { threads: Thread[]; activeId: string } {
  try {
    const raw = sessionStorage.getItem(THREADS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedChat;
      if (parsed?.v === 2 && Array.isArray(parsed.threads) && parsed.threads.length > 0) {
        const threads = parsed.threads.map((thread) => ({
          ...thread,
          unread: !!thread.unread,
          messages: (thread.messages ?? []).map((m) => ({
            ...m,
            id: m.id || crypto.randomUUID(),
          })),
        }));
        const activeId = threads.some((t) => t.id === parsed.activeId)
          ? parsed.activeId
          : threads[0].id;
        return { threads, activeId };
      }
    }
  } catch {
    // fall through to the v1 migration
  }

  const legacy = loadStoredMessages();
  if (legacy.length > 0) {
    const firstAsk = legacy.find((m) => m.role === "user");
    const thread = newThread(firstAsk ? deriveTitle(firstAsk.content) : "");
    thread.messages = legacy;
    thread.sessionId = loadStoredSessionId();
    return { threads: [thread], activeId: thread.id };
  }

  const thread = newThread();
  return { threads: [thread], activeId: thread.id };
}

// Chakra's preflight sets `list-style: none` on ol/ul inside @layer reset, which
// silently ate every bullet and number in the agent's answers. An emotion style
// prop is unlayered, so it wins without !important. Destructure only `children` —
// spreading rest props collides Components' ref type with Box's and breaks tsc.
const MD_COMPONENTS: Components = {
  ul: ({ children }) => (
    <Box as="ul" listStyleType="disc" listStylePosition="outside" mb={2}>
      {children}
    </Box>
  ),
  ol: ({ children }) => (
    <Box as="ol" listStyleType="decimal" listStylePosition="outside" mb={2}>
      {children}
    </Box>
  ),
  li: ({ children }) => (
    <Box as="li" display="list-item" mb={1}>
      {children}
    </Box>
  ),
};

// The agent's tool names are Python identifiers. Say what the tool did instead.
const TOOL_LABELS: Record<string, string> = {
  knowledge_delta: "Compared this talk with what you know",
  capture_learning: "Saved what you just learned",
  what_should_i_watch: "Ranked your talks by what is new",
  quiz_me: "Wrote questions to check what you know",
  learning_frontier: "Worked out what to learn next",
  search_video_moments: "Searched the talks",
  twelvelabs_search: "Searched inside the video",
  explore_graph: "Looked up how this connects",
  run_cypher: "Queried your knowledge graph",
  get_graph_schema: "Checked how the graph is organised",
};

function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Video ids, session ids and hashes mean nothing to a viewer — they only
// identify a row to the backend. Never render one.
function isOpaqueId(value: string): boolean {
  return /^[0-9a-f]{16,}(#\d+)?$/i.test(value) || /^[0-9a-f-]{32,}$/i.test(value);
}

/** Tool arguments worth showing, as `label: value` with ids and blanks dropped. */
function readableInputs(inputs: Record<string, unknown>): string[] {
  return Object.entries(inputs)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => [key.replace(/_/g, " "), String(value)] as const)
    .filter(([, value]) => !isOpaqueId(value))
    .map(([label, value]) => `${label}: ${value}`);
}

const THINKING_PATTERNS = [
  /^let me /i, /^i'll /i, /^i will /i, /^first,? i /i,
  /^now let me /i, /^let me also /i, /^let me try /i,
  /^i need to /i, /^i should /i, /^let me check /i,
  /^let me look /i, /^let me search /i, /^let me query /i,
  /^let me find /i, /^now i'll /i, /^now i need /i,
];

// Patterns for lines that continue a thinking block (e.g., "and then...", "also...")
const CONTINUATION_PATTERNS = [
  /^(and |also |then |additionally |next |finally )/i,
  /^(this will |this should |this means |that way )/i,
  /^(so |because |since |in order to )/i,
  /^(after that |once |before )/i,
];

// Lines with markdown formatting indicate actual response content
const MARKDOWN_LINE = /^(#{1,6} |[-*] |\d+\. |\|)/;

function splitThinkingAndResponse(text: string): { thinking: string; response: string } {
  // Don't split if text contains error indicators
  if (/\berror\b/i.test(text) || /\bfailed\b/i.test(text) || /\bsyntax error\b/i.test(text)) {
    return { thinking: "", response: text };
  }

  const lines = text.split("\n");
  const thinkingLines: string[] = [];
  const responseLines: string[] = [];
  let foundResponse = false;
  let inThinkingBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundResponse && trimmed && THINKING_PATTERNS.some((p) => p.test(trimmed))) {
      thinkingLines.push(line);
      inThinkingBlock = true;
    } else if (
      inThinkingBlock &&
      !foundResponse &&
      trimmed &&
      !MARKDOWN_LINE.test(trimmed) &&
      (CONTINUATION_PATTERNS.some((p) => p.test(trimmed)) || trimmed.length < 80)
    ) {
      // Short continuation lines within a thinking block
      thinkingLines.push(line);
    } else {
      if (trimmed) {
        foundResponse = true;
        inThinkingBlock = false;
      }
      responseLines.push(line);
    }
  }

  const response = responseLines.join("\n").trim();
  const thinking = thinkingLines.join("\n").trim();

  // If response is empty but we have thinking text, show everything as response
  if (!response && thinking) {
    return { thinking: "", response: text };
  }

  return { thinking, response };
}

function loadStoredMessages(): Message[] {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored).map((m: Message) => ({ ...m, id: m.id || crypto.randomUUID() }));
  } catch {
    return [];
  }
}

function loadStoredSessionId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function ChatInterface({ onGraphUpdate, externalInput, onExternalInputConsumed }: ChatInterfaceProps) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState("");
  const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCall[]>([]);
  const [streamingEntities, setStreamingEntities] = useState<ExtractedEntity[]>([]);
  const [streamingPreferences, setStreamingPreferences] = useState<DetectedPreference[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textBufferRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Refs mirror streamingEntities/Preferences so the "done" handler reads
  // the accumulated values synchronously — the useState equivalents may be
  // one render behind when "done" fires immediately after extraction events.
  const streamingEntitiesRef = useRef<ExtractedEntity[]>([]);
  const streamingPreferencesRef = useRef<DetectedPreference[]>([]);
  // A thread created this tick must be visible to sendMessage before React
  // re-renders, so refs — not state — are the source of truth for thread
  // identity. State exists only to paint.
  const threadsRef = useRef<Thread[]>([]);
  const activeIdRef = useRef("");
  const draftsRef = useRef<Map<string, string>>(new Map());
  const pendingExternalRef = useRef<{ value: string; threadId: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tabRefs = useRef<Map<string, HTMLElement>>(new Map());
  const prevActiveRef = useRef("");

  const commitThreads = useCallback((fn: (prev: Thread[]) => Thread[]) => {
    const next = fn(threadsRef.current);
    if (next === threadsRef.current) return;
    threadsRef.current = next;
    setThreads(next);
  }, []);

  const patchThread = useCallback(
    (id: string, fn: (thread: Thread) => Thread) => {
      commitThreads((prev) => {
        if (!prev.some((t) => t.id === id)) return prev;
        return prev.map((t) => (t.id === id ? fn(t) : t));
      });
    },
    [commitThreads],
  );

  const setActive = useCallback((id: string) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  const activeThread = threads.find((t) => t.id === activeId) ?? null;
  const messages = activeThread?.messages ?? NO_MESSAGES;
  const isActiveStreaming = loading && streamingThreadId === activeId;
  const streamingTitle =
    threads.find((t) => t.id === streamingThreadId)?.title || "Untitled";

  // Hydrate from sessionStorage after mount to avoid SSR mismatch
  useEffect(() => {
    const loaded = loadThreads();
    threadsRef.current = loaded.threads;
    setThreads(loaded.threads);
    activeIdRef.current = loaded.activeId;
    setActiveId(loaded.activeId);
    prevActiveRef.current = loaded.activeId;
    setHydrated(true);
  }, []);

  // A concept clicked anywhere else in the app (the knowledge map, What I know)
  // arrives here as `externalInput`. It opens its OWN thread rather than
  // appending to whatever conversation happens to be in front — clicking a note
  // is a new question, not a follow-up.
  //
  // `loading` stays in the deps deliberately: only one request may stream at a
  // time, so a click that lands mid-answer creates its thread immediately and
  // sends the moment the in-flight answer finishes.
  useEffect(() => {
    if (!hydrated) return;
    if (!externalInput) {
      pendingExternalRef.current = null;
      return;
    }

    let threadId: string | null = null;
    const pending = pendingExternalRef.current;
    // The pending thread must still exist — the user may have closed it while
    // the send was deferred, and targeting a dead id would swallow the question.
    const pendingThread = pending
      ? threadsRef.current.find((t) => t.id === pending.threadId)
      : undefined;

    if (pending && pendingThread) {
      if (pending.value === externalInput) {
        threadId = pending.threadId;
      } else if (pendingThread.messages.length === 0) {
        threadId = pending.threadId;
        patchThread(threadId, (t) => ({ ...t, title: deriveTitle(externalInput) }));
        pendingExternalRef.current = { value: externalInput, threadId };
      }
    }

    if (!threadId) {
      const title = deriveTitle(externalInput);
      const active = threadsRef.current.find((t) => t.id === activeIdRef.current);
      if (active && active.messages.length === 0 && active.id !== streamingThreadId) {
        // Reuse an idle blank thread rather than opening a blank tab beside it.
        threadId = active.id;
        patchThread(threadId, (t) => ({ ...t, title }));
      } else {
        threadId = createThread(title);
      }
      pendingExternalRef.current = { value: externalInput, threadId };
    }

    if (!loading) {
      void sendMessage(externalInput, threadId);
      onExternalInputConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalInput, loading, hydrated]);

  useEffect(() => {
    // Switching tabs should jump, not animate through the other thread's history.
    const behavior = prevActiveRef.current === activeId ? "smooth" : "auto";
    prevActiveRef.current = activeId;
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, [activeId, messages, streamingContent, streamingToolCalls]);

  useEffect(() => {
    tabRefs.current.get(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  // Elapsed time counter during loading
  useEffect(() => {
    if (!loading) { setElapsedSeconds(0); return; }
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [loading]);

  // Persist every thread to sessionStorage. The `hydrated` guard matters now:
  // without it the first commit writes an empty thread list over stored history
  // before the hydrate effect lands.
  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(
        THREADS_KEY,
        JSON.stringify({ v: 2, activeId, threads } satisfies PersistedChat),
      );
    } catch { console.warn("Failed to persist chat threads to sessionStorage"); }
  }, [threads, activeId, hydrated]);

  // Throttle streaming text updates to ~50ms to avoid excessive ReactMarkdown re-renders
  const flushTextBuffer = useCallback(() => {
    setStreamingContent(textBufferRef.current);
    flushTimerRef.current = null;
  }, []);

  const appendStreamingText = useCallback((text: string) => {
    textBufferRef.current += text;
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushTextBuffer, 50);
    }
  }, [flushTextBuffer]);

  function cancelRequest() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }

  function switchTo(id: string) {
    if (id === activeIdRef.current) return;
    draftsRef.current.set(activeIdRef.current, input);
    setInput(draftsRef.current.get(id) ?? "");
    setActive(id);
    patchThread(id, (t) => (t.unread ? { ...t, unread: false } : t));
  }

  function createThread(title = ""): string {
    draftsRef.current.set(activeIdRef.current, input);
    const thread = newThread(title);
    commitThreads((prev) => [...prev, thread]);
    setActive(thread.id);
    setInput("");
    return thread.id;
  }

  function handleNewThread() {
    // Always produce a tab. A + whose first press does nothing reads as broken,
    // and this is the button's only introduction.
    createThread();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function closeThread(id: string) {
    // Closing the streaming thread is the only path that aborts — there is no
    // longer anywhere to deliver the answer.
    if (id === streamingThreadId) {
      cancelRequest();
      setLoading(false);
      setStreamingThreadId(null);
    }
    if (pendingExternalRef.current?.threadId === id) pendingExternalRef.current = null;
    draftsRef.current.delete(id);

    const prev = threadsRef.current;
    const index = prev.findIndex((t) => t.id === id);
    const rest = prev.filter((t) => t.id !== id);

    if (rest.length === 0) {
      const thread = newThread();
      commitThreads(() => [thread]);
      setActive(thread.id);
      setInput("");
      return;
    }

    commitThreads(() => rest);
    if (id === activeIdRef.current) {
      const next = rest[Math.min(index, rest.length - 1)];
      setActive(next.id);
      setInput(draftsRef.current.get(next.id) ?? "");
      patchThread(next.id, (t) => (t.unread ? { ...t, unread: false } : t));
    }
  }

  async function sendMessage(text?: string, targetThreadId?: string) {
    const messageText = text || input.trim();
    const targetId = targetThreadId ?? activeIdRef.current;
    if (!messageText || loading) return;
    if (!threadsRef.current.some((t) => t.id === targetId)) return;

    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: messageText };
    patchThread(targetId, (t) => ({
      ...t,
      title: t.title || deriveTitle(messageText),
      messages: [...t.messages, userMessage],
    }));
    // Only a send that came from the composer may clear it — a prompt card, a
    // retry or a deferred note click must not wipe a draft in another tab.
    if (!text) setInput("");
    setLoading(true);
    setStreamingThreadId(targetId);
    setStreamingContent("");
    setStreamingToolCalls([]);
    setStreamingEntities([]);
    setStreamingPreferences([]);
    streamingEntitiesRef.current = [];
    streamingPreferencesRef.current = [];
    textBufferRef.current = "";

    const controller = new AbortController();
    abortControllerRef.current = controller;
    // Activity-based timeout: resets on each SSE event (120s idle)
    let timeout = setTimeout(() => controller.abort(), 120000);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), 120000);
    };

    try {
      const res = await fetch(`${API_BASE}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: messageText,
          // Read the session at call time from the thread being sent to —
          // taking it from the rendered thread would send one thread's agent
          // memory key with another thread's message.
          session_id:
            threadsRef.current.find((t) => t.id === targetId)?.sessionId ?? null,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        const detail = errorData?.detail || `Backend error (${res.status})`;
        throw new Error(detail);
      }

      if (!res.body) {
        throw new Error("No response body for streaming");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let toolCalls: ToolCall[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ") && eventType) {
            resetTimeout();
            try {
              const data = JSON.parse(line.slice(6));
              switch (eventType) {
                case "session_id":
                  patchThread(targetId, (t) => ({ ...t, sessionId: data.session_id }));
                  break;

                case "tool_start":
                  toolCalls = [
                    ...toolCalls,
                    {
                      name: data.name,
                      inputs: data.inputs,
                      output_preview: "",
                      status: "running",
                    },
                  ];
                  setStreamingToolCalls([...toolCalls]);
                  break;

                case "tool_end": {
                  const endName = data.name;
                  let matched = false;
                  toolCalls = toolCalls.map((tc) => {
                    if (tc.name === endName && tc.status === "running" && !matched) {
                      matched = true;
                      return {
                        ...tc,
                        output_preview: data.output_preview || "",
                        status: "complete" as const,
                        graph_data: data.graph_data,
                      };
                    }
                    return tc;
                  });
                  setStreamingToolCalls([...toolCalls]);
                  // A background thread must not yank the graph panel out from
                  // under whatever the viewer is currently looking at.
                  if (
                    data.graph_data?.results?.length &&
                    onGraphUpdate &&
                    targetId === activeIdRef.current
                  ) {
                    onGraphUpdate(data.graph_data);
                  }
                  break;
                }

                case "text_delta":
                  fullText += data.text;
                  appendStreamingText(data.text);
                  break;

                case "entities_extracted":
                  if (data.entities?.length) {
                    streamingEntitiesRef.current = [
                      ...streamingEntitiesRef.current,
                      ...data.entities,
                    ];
                    setStreamingEntities([...streamingEntitiesRef.current]);
                  }
                  break;

                case "preferences_detected":
                  if (data.preferences?.length) {
                    streamingPreferencesRef.current = [
                      ...streamingPreferencesRef.current,
                      ...data.preferences,
                    ];
                    setStreamingPreferences([...streamingPreferencesRef.current]);
                  }
                  break;

                case "done": {
                  // Flush any remaining buffered text
                  if (flushTimerRef.current) {
                    clearTimeout(flushTimerRef.current);
                    flushTimerRef.current = null;
                  }
                  // Read accumulated entities/preferences from refs (state may
                  // be one render behind for events that fired this tick).
                  const finalEntities = streamingEntitiesRef.current;
                  const finalPreferences = streamingPreferencesRef.current;
                  patchThread(targetId, (t) => ({
                    ...t,
                    unread: targetId !== activeIdRef.current,
                    messages: [
                      ...t.messages,
                      {
                        id: crypto.randomUUID(),
                        role: "assistant",
                        content: data.response || fullText,
                        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                        entities: finalEntities.length > 0 ? [...finalEntities] : undefined,
                        preferences:
                          finalPreferences.length > 0 ? [...finalPreferences] : undefined,
                      },
                    ],
                  }));
                  setStreamingContent("");
                  setStreamingToolCalls([]);
                  setStreamingEntities([]);
                  setStreamingPreferences([]);
                  streamingEntitiesRef.current = [];
                  streamingPreferencesRef.current = [];
                  textBufferRef.current = "";
                  break;
                }

                case "error":
                  throw new Error(data.detail || "Streaming error");
              }
            } catch (parseErr) {
              if (parseErr instanceof SyntaxError) {
                // JSON parse error — skip malformed event
              } else {
                throw parseErr;
              }
            }
            eventType = "";
          }
        }
      }
    } catch (err: unknown) {
      // Flush any partial streaming state
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      let errorMsg: string;
      if (err instanceof DOMException && err.name === "AbortError") {
        errorMsg = "Request timed out or was cancelled. Please try again.";
      } else if (err instanceof Error && err.message) {
        errorMsg = err.message;
      } else {
        errorMsg = "Cannot reach the backend. Is it running?";
      }
      // A failure in a background thread needs its unread dot too, or the
      // error stays invisible until the viewer happens to switch back.
      patchThread(targetId, (t) => ({
        ...t,
        unread: targetId !== activeIdRef.current,
        messages: [
          ...t.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `**Error:** ${errorMsg}`,
            retryInput: messageText,
          },
        ],
      }));
      setStreamingContent("");
      setStreamingToolCalls([]);
      setStreamingEntities([]);
      setStreamingPreferences([]);
      streamingEntitiesRef.current = [];
      streamingPreferencesRef.current = [];
      textBufferRef.current = "";
    } finally {
      clearTimeout(timeout);
      abortControllerRef.current = null;
      setLoading(false);
      setStreamingThreadId(null);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      // While another thread streams, let the newline through rather than
      // eating the keystroke on a send that would be silently rejected.
      if (loading) return;
      e.preventDefault();
      sendMessage();
    }
  }

  // Collect all prompts for suggested questions display
  const allPrompts = DEMO_SCENARIOS.flatMap((s) => s.prompts);

  return (
    <Flex direction="column" h="100%" bg="#fbfbfc">
      {/* Parallel conversations. The page header already says "Ask Delta", so
          this strip carries no title of its own — only the threads and the +,
          which is always present so the affordance is visible before there is
          a second chat to switch to. */}
      <HStack
        px={2}
        py={2}
        gap={1}
        bg="white"
        borderBottom="1px solid"
        borderColor="#e5e6e9"
        flexShrink={0}
      >
        <HStack
          role="tablist"
          flex={1}
          minW={0}
          gap={1}
          overflowX="auto"
          css={{ scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}
        >
          {threads.map((thread) => {
            const isActive = thread.id === activeId;
            const isStreaming = thread.id === streamingThreadId;
            return (
              <HStack
                key={thread.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(thread.id, el);
                  else tabRefs.current.delete(thread.id);
                }}
                className="group"
                role="tab"
                aria-selected={isActive}
                title={thread.title || "Untitled"}
                onClick={() => switchTo(thread.id)}
                h="32px"
                maxW="200px"
                flexShrink={0}
                ps={3}
                pe={1}
                gap={2}
                borderRadius="8px"
                cursor="pointer"
                bg={isActive ? "#f4f3ff" : "transparent"}
                color={isActive ? "#4640c8" : "gray.500"}
                fontWeight={isActive ? "medium" : "normal"}
                _hover={isActive ? undefined : { bg: "#f3f4f6", color: "gray.700" }}
                transition="background-color 0.12s, color 0.12s"
              >
                {(isStreaming || thread.unread) && (
                  <Box
                    w="8px"
                    h="8px"
                    borderRadius="full"
                    flexShrink={0}
                    bg={isStreaming ? "#625bf6" : "gray.400"}
                    animation={isStreaming ? "delta-pulse 1.4s ease-in-out infinite" : undefined}
                  />
                )}
                <Text fontSize="sm" minW={0} lineClamp={1}>
                  {thread.title || "Untitled"}
                </Text>
                {/* The slot is always reserved so a tab does not reflow on hover. */}
                <IconButton
                  aria-label={`Close ${thread.title || "this chat"}`}
                  size="2xs"
                  variant="ghost"
                  color="gray.400"
                  flexShrink={0}
                  opacity={0}
                  _groupHover={{ opacity: 1 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeThread(thread.id);
                  }}
                >
                  <X size={12} />
                </IconButton>
              </HStack>
            );
          })}
        </HStack>
        {/* Outside the scroller, so it holds the same pixel with 1 tab or 12. */}
        <IconButton
          aria-label="Start a new chat"
          title="Start a new chat"
          size="xs"
          variant="ghost"
          color="gray.500"
          borderRadius="8px"
          flexShrink={0}
          onClick={handleNewThread}
        >
          <Plus size={16} />
        </IconButton>
      </HStack>

      {/* Suggested questions. Gated on THIS thread streaming, not on any thread —
          otherwise opening a tab mid-answer shows a blank column. */}
      {messages.length === 0 && !isActiveStreaming && (
        <Flex direction="column" flex={1} justify="center" px={{ base: 4, md: 8 }} py={8}>
          <VStack gap={0} w="100%" maxW="760px" mx="auto">
            <Flex
              align="center"
              justify="center"
              w={10}
              h={10}
              mb={4}
              borderRadius="12px"
              bg="#f0efff"
              color="#625bf6"
            >
              <Sparkles size={18} />
            </Flex>
            <Text
              fontSize={{ base: "xl", md: "2xl" }}
              fontWeight="semibold"
              letterSpacing="-0.03em"
              color="gray.900"
            >
              What do you want to learn?
            </Text>
            <Text mt={2} maxW="500px" textAlign="center" fontSize="sm" color="gray.500">
              Ask about a talk, compare it with your knowledge, or plan what to watch next.
            </Text>
            <Grid
              w="100%"
              mt={8}
              templateColumns={{ base: "1fr", lg: "repeat(2, minmax(0, 1fr))" }}
              gap={2}
            >
              {allPrompts.map((prompt) => (
                <Button
                  key={prompt}
                  variant="outline"
                  justifyContent="space-between"
                  alignItems="center"
                  minH="64px"
                  px={4}
                  py={3}
                  borderColor="#e0e1e4"
                  borderRadius="12px"
                  bg="white"
                  color="gray.700"
                  fontSize="13px"
                  fontWeight="medium"
                  whiteSpace="normal"
                  textAlign="left"
                  height="auto"
                  lineHeight="1.45"
                  _hover={{ borderColor: "#c8c4fa", bg: "#faf9ff", color: "gray.900" }}
                  // Only one request streams at a time. Without this the cards
                  // look live and silently do nothing while another tab answers.
                  disabled={loading}
                  onClick={() => sendMessage(prompt)}
                  title={prompt}
                >
                  <Text flex={1}>{prompt}</Text>
                  <ArrowUpRight size={14} color="#8b87aa" />
                </Button>
              ))}
            </Grid>
          </VStack>
        </Flex>
      )}

      {/* Messages */}
      <VStack
        flex={1}
        w="100%"
        maxW="768px"
        mx="auto"
        overflow="auto"
        px={4}
        py={4}
        gap={6}
        align="stretch"
        display={messages.length === 0 && !isActiveStreaming ? "none" : "flex"}
      >
        {messages.map((msg) =>
          /* Speaker is carried by position and weight rather than by giving every
             turn a card — the identical bordered boxes were what made the thread
             read as one undifferentiated wall. */
          msg.role === "user" ? (
            <Box
              key={msg.id}
              alignSelf="flex-end"
              maxW="80%"
              bg="#f0efff"
              color="gray.900"
              px={3}
              py={2}
              borderRadius="12px"
              borderBottomRightRadius="4px"
            >
              <Text fontSize="sm" whiteSpace="pre-wrap">{msg.content}</Text>
            </Box>
          ) : (
            <Box key={msg.id}>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <ToolCallTimeline toolCalls={msg.toolCalls} />
              )}
              <Box>
                <Box>
                  {/* 15px/1.7 is a reading measure, not a UI measure, and these
                      answers are long. tabular-nums stops the timecodes this
                      product is full of wobbling out of column. */}
                  <Box
                    className="markdown-content"
                    fontSize="15px"
                    lineHeight="1.7"
                    color="gray.800"
                    fontVariantNumeric="tabular-nums"
                    overflowWrap="anywhere"
                    {...(msg.retryInput
                      ? {
                          bg: "#fdf9f9",
                          borderStartWidth: "2px",
                          borderColor: "red.400",
                          ps: 3,
                          py: 2,
                          borderRadius: "8px",
                        }
                      : {})}
                  >
                    {(() => {
                      const { thinking, response } = splitThinkingAndResponse(msg.content);
                      return (
                        <>
                          {thinking && (
                            <Collapsible.Root>
                              <Collapsible.Trigger asChild>
                                <Button variant="ghost" size="xs" mb={1} color="gray.500">
                                  <ChevronDown size={12} />
                                  Show reasoning
                                </Button>
                              </Collapsible.Trigger>
                              <Collapsible.Content>
                                <Box px={2} py={1} mb={2} bg="gray.100" borderRadius="sm" fontSize="xs" color="gray.600">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{thinking}</ReactMarkdown>
                                </Box>
                              </Collapsible.Content>
                            </Collapsible.Root>
                          )}
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{response || msg.content}</ReactMarkdown>
                        </>
                      );
                    })()}
                    {/* Things this answer named. The type is a backend label —
                        keep it in the tooltip, not on the chip. */}
                    {msg.entities && msg.entities.length > 0 && (
                      <Box mt={3}>
                        <Text fontSize="xs" color="gray.500" mb={1}>
                          Mentioned here
                        </Text>
                        <HStack gap={1} flexWrap="wrap">
                          {msg.entities.map((e, i) => (
                            <Badge
                              key={`${e.type}-${e.name}-${i}`}
                              size="xs"
                              colorPalette="gray"
                              variant="subtle"
                              title={e.subtype ? `${e.type} · ${e.subtype}` : e.type}
                            >
                              {e.name}
                            </Badge>
                          ))}
                        </HStack>
                      </Box>
                    )}
                    {/* Detected preferences */}
                    {msg.preferences && msg.preferences.length > 0 && (
                      <Box mt={2}>
                        <Text fontSize="xs" color="gray.500" mb={1}>
                          Noted about you
                        </Text>
                        <HStack gap={1} flexWrap="wrap">
                          {msg.preferences.map((p, i) => (
                            <Badge
                              key={`${p.category}-${p.preference}-${i}`}
                              size="xs"
                              colorPalette="gray"
                              variant="subtle"
                              title={p.category}
                            >
                              {p.preference}
                            </Badge>
                          ))}
                        </HStack>
                      </Box>
                    )}
                    {msg.retryInput && (
                      <Button
                        size="xs"
                        variant="outline"
                        mt={2}
                        onClick={() => {
                          // Retry only ever renders inside the active thread.
                          patchThread(activeIdRef.current, (t) => ({
                            ...t,
                            messages: t.messages.filter((m) => m.id !== msg.id),
                          }));
                          sendMessage(msg.retryInput);
                        }}
                      >
                        <RotateCcw size={12} />
                        Retry
                      </Button>
                    )}
                  </Box>
                </Box>
              </Box>
            </Box>
          ),
        )}

        {/* Streaming — only for the thread on screen, and styled identically to
            a committed answer so the text does not jump when the stream ends. */}
        {isActiveStreaming && (
          <Box>
            {streamingToolCalls.length > 0 && (
              <ToolCallTimeline toolCalls={streamingToolCalls} live />
            )}
            {streamingContent ? (
              <Box
                className="markdown-content"
                fontSize="15px"
                lineHeight="1.7"
                color="gray.800"
                fontVariantNumeric="tabular-nums"
                overflowWrap="anywhere"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                  {streamingContent}
                </ReactMarkdown>
              </Box>
            ) : (
              <VStack align="stretch" gap={2}>
                <HStack gap={2}>
                  <Spinner size="xs" color="#625bf6" />
                  {/* Name the step. "Running tool 3 of 2" — which the old counter
                      produced once every call finished — is not a sentence
                      anyone can act on. */}
                  <Text fontSize="sm" color="gray.500">
                    {streamingToolCalls.length === 0
                      ? "Thinking…"
                      : `${toolLabel(
                          (streamingToolCalls.find((tc) => tc.status === "running") ||
                            streamingToolCalls[streamingToolCalls.length - 1]).name,
                        )}…`}
                  </Text>
                  {elapsedSeconds > 3 && (
                    <Text fontSize="xs" color="gray.400">{elapsedSeconds}s</Text>
                  )}
                </HStack>
                {streamingToolCalls.length === 0 && (
                  <>
                    <Skeleton height="4" width="80%" />
                    <Skeleton height="4" width="60%" />
                  </>
                )}
              </VStack>
            )}
          </Box>
        )}
        <div ref={messagesEndRef} />
      </VStack>

      {/* Input area — Chakra UI Pro inspired bordered container */}
      <Box px={4} py={3} borderTop="1px solid" borderColor="#e5e6e9" bg="white">
        {/* One request streams at a time. Say so, and say where — otherwise a
            disabled composer just reads as a hang. */}
        {loading && streamingThreadId && streamingThreadId !== activeId && (
          <HStack maxW="768px" mx="auto" mb={2} gap={1}>
            <Text fontSize="xs" color="gray.500">
              Answering in “{streamingTitle}”
            </Text>
            <Button
              size="xs"
              variant="ghost"
              color="gray.600"
              onClick={() => switchTo(streamingThreadId)}
            >
              Go there
            </Button>
          </HStack>
        )}
        <Box
          maxW="768px"
          mx="auto"
          borderWidth="1px"
          borderColor="#dedfe3"
          rounded="12px"
          bg="#fafafa"
          boxShadow="0 2px 8px rgba(17,24,39,0.035)"
          _focusWithin={{ borderColor: "#aaa5f7", boxShadow: "0 0 0 3px rgba(98,91,246,0.10)" }}
          transition="border-color 0.2s, box-shadow 0.2s"
        >
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about a talk, concept, or learning goal…"
            border="none"
            _focus={{ boxShadow: "none" }}
            resize="none"
            rows={2}
            fontSize="sm"
            px={3}
            py={2}
            bg="transparent"
          />
          <HStack px={2} py={2} justify="space-between">
            {/* Teach the shortcut at the moment of use. `visibility` rather than
                `display` so the row does not change height when it appears. */}
            <Text
              fontSize="xs"
              color="gray.400"
              display={{ base: "none", sm: "block" }}
              visibility={input ? "visible" : "hidden"}
            >
              Enter to send, Shift+Enter for new line
            </Text>
            {isActiveStreaming ? (
              <IconButton
                aria-label="Stop generating"
                title="Stop generating"
                onClick={cancelRequest}
                size="xs"
                variant="outline"
                rounded="8px"
              >
                <Square size={12} fill="currentColor" />
              </IconButton>
            ) : (
              <IconButton
                aria-label="Send"
                onClick={() => sendMessage()}
                disabled={!input.trim() || loading}
                size="xs"
                colorPalette="purple"
                rounded="8px"
              >
                <Send size={14} />
              </IconButton>
            )}
          </HStack>
        </Box>
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Tool call timeline component
// ---------------------------------------------------------------------------

// Open while the agent is working — watching it traverse the graph is the point.
// Once the answer has landed it collapses to one grey line of finished plumbing.
function ToolCallTimeline({ toolCalls, live }: { toolCalls: ToolCall[]; live?: boolean }) {
  return (
    <Collapsible.Root defaultOpen={live}>
      {!live && (
        <Collapsible.Trigger asChild>
          <Button variant="ghost" size="xs" px={0} mb={1} color="gray.500" fontWeight="normal">
            <Wrench size={12} />
            {toolCalls.length === 1 ? "1 step" : `${toolCalls.length} steps`}
            <ChevronDown size={12} />
          </Button>
        </Collapsible.Trigger>
      )}
      <Collapsible.Content>
        <ToolCallSteps toolCalls={toolCalls} />
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function ToolCallSteps({ toolCalls }: { toolCalls: ToolCall[] }) {
  return (
    <Timeline.Root size="sm" mb={2}>
      {toolCalls.map((tc, j) => (
        <Timeline.Item key={`${tc.name}-${j}`}>
          <Timeline.Connector>
            <Timeline.Separator />
            {/* Green means "you already know this" everywhere else in the
                product — a finished tool call is not that. */}
            <Timeline.Indicator
              bg={tc.status === "running" ? "purple.500" : "gray.400"}
              color="white"
            >
              {tc.status === "running" ? (
                <Spinner size="xs" color="white" />
              ) : (
                <Check size={10} />
              )}
            </Timeline.Indicator>
          </Timeline.Connector>
          <Timeline.Content pb={2}>
            <Collapsible.Root>
              <HStack gap={2}>
                <HStack gap={1.5} color="gray.600">
                  <Wrench size={11} />
                  <Text fontSize="xs" fontWeight="medium" title={tc.name}>
                    {toolLabel(tc.name)}
                  </Text>
                </HStack>
                {tc.status === "running" && (
                  <Text fontSize="xs" color="gray.400">working…</Text>
                )}
                {tc.output_preview && (
                  <Collapsible.Trigger asChild>
                    <Button variant="ghost" size="xs" px={1} color="gray.400">
                      <ChevronDown size={12} />
                    </Button>
                  </Collapsible.Trigger>
                )}
              </HStack>
              {tc.output_preview && (
                <Collapsible.Content>
                  <Box
                    mt={1}
                    px={2}
                    py={1}
                    bg="gray.50"
                    borderRadius="sm"
                    fontSize="xs"
                    maxH="120px"
                    overflow="auto"
                  >
                    {readableInputs(tc.inputs).length > 0 && (
                      <Text color="gray.600" mb={1} fontWeight="medium">
                        {readableInputs(tc.inputs).join(" · ")}
                      </Text>
                    )}
                    <Text color="gray.500" whiteSpace="pre-wrap">
                      {tc.output_preview.slice(0, 300)}
                      {tc.output_preview.length > 300 && "…"}
                    </Text>
                  </Box>
                </Collapsible.Content>
              )}
            </Collapsible.Root>
          </Timeline.Content>
        </Timeline.Item>
      ))}
    </Timeline.Root>
  );
}
