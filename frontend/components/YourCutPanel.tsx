"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  Heading,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Check, ChevronDown, Clock3, Play, Sparkles } from "lucide-react";
import { API_BASE } from "@/lib/config";
import { QuizFlow } from "@/components/QuizFlow";
import fixtureJson from "@/fixtures/delta.json";

interface DeltaVideo {
  id: string;
  title: string;
  duration_sec: number;
}

interface DeltaStats {
  concepts_total: number;
  known: number;
  novel: number;
  goal_hits: number;
  watch_sec: number;
  skip_sec: number;
}

interface DeltaConcept {
  name: string;
  status: "known" | "novel" | "goal";
  why?: string;
  matched_concept?: string | null;
  source?: string | null;
  goal_note?: string | null;
}

interface DeltaCut {
  start_sec: number;
  end_sec: number;
  summary: string;
  segment_id: string;
  concepts: DeltaConcept[];
}

export interface DeltaResponse {
  video: DeltaVideo;
  stats: DeltaStats;
  known_concepts: DeltaConcept[];
  cuts: DeltaCut[];
}

interface CaptureResponse {
  captured: string[];
  source_video?: string;
  nodes?: number;
  note?: string;
}

interface YourCutPanelProps {
  videoId: string;
  useFixture?: boolean;
  onSeek?: (seconds: number) => void;
  /** Emits the cut ranges so a sibling panel (the transcript) can highlight them. */
  onCutsChange?: (cuts: { start_sec: number; end_sec: number }[]) => void;
}

export const DELTA_FIXTURE = fixtureJson as DeltaResponse;

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

// The API returns goal concepts before novel ones, and the fold only shows six. Novel is
// the entire claim of the panel — it goes first, or the product argues for itself offscreen.
const CONCEPT_RANK: Record<DeltaConcept["status"], number> = { novel: 0, goal: 1, known: 2 };

function orderConcepts(concepts: DeltaConcept[]): DeltaConcept[] {
  return [...concepts].sort(
    (a, b) => (CONCEPT_RANK[a.status] ?? 3) - (CONCEPT_RANK[b.status] ?? 3),
  );
}

const CONCEPT_FOLD = 6;

/** Concept pills with an expand/collapse fold. A native <details> kept saying
 *  "Show 14 more" while it was already open, so there was no way back. */
function ConceptList({ concepts, segmentId }: { concepts: DeltaConcept[]; segmentId: string }) {
  const [expanded, setExpanded] = useState(false);
  const ordered = orderConcepts(concepts);
  const shown = expanded ? ordered : ordered.slice(0, CONCEPT_FOLD);
  const hidden = ordered.length - CONCEPT_FOLD;

  return (
    <>
      <Flex gap={2} mt={3} flexWrap="wrap">
        {shown.map((concept) => (
          <ConceptPill key={`${segmentId}-${concept.name}`} concept={concept} />
        ))}
      </Flex>
      {hidden > 0 && (
        <Text
          as="button"
          mt={2}
          cursor="pointer"
          fontSize="xs"
          fontWeight="semibold"
          color="purple.600"
          _hover={{ textDecoration: "underline" }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `Show ${hidden} more concepts`}
        </Text>
      )}
    </>
  );
}

function noteName(source?: string | null): string {
  if (!source) return "your knowledge vault";
  return source.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || source;
}

function ConceptPill({ concept }: { concept: DeltaConcept }) {
  const isGoal = concept.status === "goal";
  return (
    <Box
      px={2.5}
      py={1.5}
      borderWidth="1px"
      borderColor={isGoal ? "#cbdcf8" : "#f2d5b5"}
      borderRadius="9px"
      bg={isGoal ? "#f3f7fd" : "#fff8f0"}
    >
      <Text
        fontSize="xs"
        fontWeight="semibold"
        color={isGoal ? "blue.800" : "orange.800"}
        lineHeight="1.3"
      >
        {concept.name}
      </Text>
      <Text mt={0.5} fontSize="10px" color={isGoal ? "blue.600" : "orange.600"}>
        {concept.why ||
          (isGoal ? "you asked to learn this" : "not in your knowledge base")}
      </Text>
    </Box>
  );
}

export function YourCutPanel({
  videoId,
  useFixture = false,
  onSeek,
  onCutsChange,
}: YourCutPanelProps) {
  const [data, setData] = useState<DeltaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFixture, setIsFixture] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState<string[] | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [quizOpen, setQuizOpen] = useState(false);

  const loadDelta = useCallback(async () => {
    setLoading(true);
    setError(null);

    if (useFixture) {
      setData(DELTA_FIXTURE);
      setIsFixture(true);
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/delta/${encodeURIComponent(videoId)}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        throw new Error(`Your Cut request failed (${response.status})`);
      }
      setData((await response.json()) as DeltaResponse);
      setIsFixture(false);
    } catch (requestError) {
      setData(null);
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to load your personalized cut.",
      );
    } finally {
      setLoading(false);
    }
  }, [useFixture, videoId]);

  useEffect(() => {
    setCaptured(null);
    setCaptureError(null);
    void loadDelta();
  }, [loadDelta]);

  useEffect(() => {
    onCutsChange?.(
      (data?.cuts || []).map((cut) => ({
        start_sec: cut.start_sec,
        end_sec: cut.end_sec,
      })),
    );
  }, [data, onCutsChange]);

  const novelConcepts = useMemo(() => {
    if (!data) return [];
    return Array.from(
      new Set(
        data.cuts.flatMap((cut) =>
          cut.concepts
            .filter((concept) => concept.status === "novel")
            .map((concept) => concept.name),
        ),
      ),
    );
  }, [data]);

  // What the quiz can actually test — not just novel. A video can be all goal-aligned
  // and zero novel (one of ours is exactly that), and the quiz endpoint happily returns
  // questions for it. Gating capture on `novel` alone left the product's centrepiece
  // behind a dead button on that video, which reads as broken rather than as a decision.
  const quizzableConcepts = useMemo(() => {
    if (!data) return [];
    return Array.from(
      new Set(
        data.cuts.flatMap((cut) =>
          cut.concepts
            .filter((c) => c.status === "novel" || c.status === "goal")
            .map((c) => c.name),
        ),
      ),
    );
  }, [data]);

  async function captureLearnings() {
    if (!data) return;
    setCapturing(true);
    setCaptured(null);
    setCaptureError(null);

    if (isFixture) {
      setCaptured(novelConcepts);
      setCapturing(false);
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video: data.video.id }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        throw new Error(`Capture request failed (${response.status})`);
      }
      const result = (await response.json()) as CaptureResponse;
      setCaptured(result.captured || []);
      await loadDelta();
    } catch (requestError) {
      setCaptureError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to capture learnings.",
      );
    } finally {
      setCapturing(false);
    }
  }

  if (loading) {
    return (
      <Flex minH="220px" align="center" justify="center" direction="column" gap={3}>
        <Spinner size="sm" color="purple.500" />
        <Text fontSize="xs" color="gray.500">Calculating what is new to you…</Text>
      </Flex>
    );
  }

  if (error || !data) {
    return (
      <Box p={4} borderWidth="1px" borderColor="red.200" borderRadius="lg" bg="red.50">
        <Heading size="sm" color="red.700">Your Cut is unavailable</Heading>
        <Text mt={1} fontSize="xs" color="red.600">
          {error || "The backend returned no personalized cut."}
        </Text>
        <Button mt={3} size="xs" variant="outline" colorPalette="red" onClick={() => void loadDelta()}>
          Try again
        </Button>
      </Box>
    );
  }

  const totalSeconds =
    data.video.duration_sec || data.stats.watch_sec + data.stats.skip_sec;
  const skipPercent = totalSeconds
    ? Math.round((data.stats.skip_sec / totalSeconds) * 100)
    : 0;
  const noSafeSkip = data.stats.skip_sec <= 1 && data.cuts.length > 0;
  const recommendationExplanation = noSafeSkip
    ? data.stats.known === 0
      ? data.stats.goal_hits > 0
        ? "This video matches a stated learning goal, but I found no overlap with your saved knowledge, so I’m not claiming any part is safe to skip."
        : "I found no overlap with your saved knowledge or stated goals, so I’m not claiming any part is safe to skip."
      : "Every section still contains something new, so I’m not claiming any part is safe to skip."
    : // "You already know the rest" is a claim about the viewer, so it needs the graph
      // to back it. On a talk with 4 known and 36 novel concepts, four notes cannot
      // explain forty minutes of skipping — the rest was dropped for low novelty
      // density, which is a statement about the video, not about the viewer.
      data.stats.known > 0 && data.stats.known >= data.stats.novel
      ? "You already know the rest."
      : data.stats.known > 0
        ? `The rest is skippable on density, not because you know it — ${data.stats.known} concept${data.stats.known === 1 ? "" : "s"} here overlap your notes.`
        : "I’m skipping the rest for relevance, not familiarity — none of it introduced a new concept or touched a goal.";

  return (
    <VStack align="stretch" gap={4} pb={3}>
      <Box
        p={{ base: 4, lg: 5 }}
        borderWidth="1px"
        borderColor="#2d3142"
        borderRadius="16px"
        color="white"
        background="linear-gradient(135deg, #181a22 0%, #202334 100%)"
        boxShadow="0 12px 28px rgba(17,19,24,0.14)"
      >
        <HStack justify="space-between" align="start" mb={4}>
          <Box>
            <Text fontSize="xs" fontWeight="semibold" letterSpacing="0.02em" color="#aaa5ff">
              Your cut
            </Text>
            <Text mt={1} fontSize="xs" color="whiteAlpha.600">
              Personalized from your saved knowledge
            </Text>
          </Box>
          <HStack gap={1.5} flexWrap="wrap" justify="flex-end">
            {isFixture && (
              <Badge colorPalette="purple" variant="solid" size="sm">Fixture preview</Badge>
            )}
            <Badge
              colorPalette={skipPercent === 0 ? "orange" : "purple"}
              variant="solid"
              size="sm"
            >
              {skipPercent}% skipped
            </Badge>
          </HStack>
        </HStack>

        <Heading
          fontSize={{ base: "2xl", lg: "32px" }}
          lineHeight="1.05"
          letterSpacing="-0.045em"
          maxW="680px"
        >
          Watch {formatTime(data.stats.watch_sec)}{" "}
          <Text as="span" color="whiteAlpha.500" fontWeight="normal">
            of {formatTime(totalSeconds)}
          </Text>
        </Heading>
        <Text mt={3} maxW="680px" fontSize="sm" color="whiteAlpha.700" lineHeight="1.55">
          {recommendationExplanation}
        </Text>

        <Box mt={5}>
          <HStack justify="space-between" mb={2}>
            <Text fontSize="10px" fontWeight="semibold" color="whiteAlpha.600">
              Study {100 - skipPercent}%
            </Text>
            <Text fontSize="10px" fontWeight="semibold" color="whiteAlpha.600">
              Skip {skipPercent}%
            </Text>
          </HStack>
          {/* Green is this app's colour for "you already know it". Skipped time is a
              duration, not a knowledge claim — on a video with known: 0 a green track
              asserted exactly what the graph denies. Time reads neutral now. */}
          <Box h="6px" overflow="hidden" borderRadius="full" bg="whiteAlpha.300">
            <Box
              h="100%"
              w={`${Math.max(0, 100 - skipPercent)}%`}
              minW={data.stats.watch_sec > 0 ? "6px" : 0}
              bg="#7c74ff"
              borderRadius="full"
            />
          </Box>
        </Box>

        <Grid
          templateColumns="repeat(3, minmax(0, 1fr))"
          mt={5}
          pt={4}
          borderTopWidth="1px"
          borderColor="whiteAlpha.200"
        >
          {[
            { value: data.stats.novel, label: "new concepts", color: "orange.300" },
            { value: data.stats.goal_hits, label: "goal matches", color: "blue.300" },
            { value: data.stats.known, label: "already known", color: "green.300" },
          ].map((stat, index) => (
            <Box
              key={stat.label}
              px={{ base: 2, md: 3 }}
              borderLeftWidth={index === 0 ? 0 : "1px"}
              borderColor="whiteAlpha.200"
            >
              <Text fontSize={{ base: "lg", md: "xl" }} fontWeight="bold" color={stat.color}>
                {stat.value}
              </Text>
              <Text fontSize="10px" color="whiteAlpha.600">{stat.label}</Text>
            </Box>
          ))}
        </Grid>
      </Box>

      {data.cuts.length === 0 ? (
        <Box
          p={6}
          textAlign="center"
          borderWidth="1px"
          borderColor={data.stats.known > 0 ? "green.200" : "gray.200"}
          borderRadius="xl"
          bg={data.stats.known > 0 ? "green.50" : "gray.50"}
        >
          {/* Green and "you already know it" are only honest when the graph can name
              what you know. With known: 0 an empty cut list means we found nothing to
              recommend — a different statement, and not a flattering one. */}
          <Text
            fontSize="sm"
            fontWeight="semibold"
            color={data.stats.known > 0 ? "green.800" : "gray.800"}
          >
            {data.stats.known > 0
              ? "Nothing new for you in this video — skip it entirely."
              : "No watch-worthy segment found in this video."}
          </Text>
          <Text
            mt={1}
            fontSize="xs"
            color={data.stats.known > 0 ? "green.700" : "gray.600"}
          >
            {data.stats.known > 0
              ? "Your saved knowledge already covers every concept we found."
              : "Nothing here matched your goals or came up as a new concept — that isn’t the same as you already knowing it."}
          </Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={3}>
          <HStack justify="space-between" px={1}>
            <Box>
              <Heading size="sm">Recommended clips</Heading>
              <Text mt={0.5} fontSize="xs" color="gray.500">
                {data.cuts.length} focused {data.cuts.length === 1 ? "section" : "sections"} in order
              </Text>
            </Box>
            <HStack gap={1.5}>
              <Badge colorPalette="orange" variant="subtle" borderRadius="full">new</Badge>
              <Badge colorPalette="blue" variant="subtle" borderRadius="full">your goal</Badge>
            </HStack>
          </HStack>

          {data.cuts.map((cut, index) => (
            <Box
              key={cut.segment_id}
              p={{ base: 3, md: 4 }}
              borderWidth="1px"
              borderColor="#e2e3e6"
              borderRadius="13px"
              bg="white"
              boxShadow="0 1px 2px rgba(17,24,39,0.025)"
              transition="border-color 0.15s ease, box-shadow 0.15s ease"
              _hover={{ borderColor: "#c9c5fa", boxShadow: "0 5px 18px rgba(15,23,42,0.05)" }}
            >
              <HStack justify="space-between" align="start" mb={2}>
                <HStack gap={2}>
                  <Flex
                    align="center"
                    justify="center"
                    w={7}
                    h={7}
                    borderRadius="lg"
                    bg="gray.900"
                    color="white"
                    fontSize="xs"
                    fontWeight="bold"
                  >
                    {String(index + 1).padStart(2, "0")}
                  </Flex>
                  <Text fontSize="xs" fontWeight="semibold" color="gray.500">
                    Study clip
                  </Text>
                </HStack>
                <Button
                  size="xs"
                  variant="subtle"
                  colorPalette="purple"
                  borderRadius="full"
                  onClick={() => onSeek?.(cut.start_sec)}
                >
                  <Play size={11} />
                  {formatTime(cut.start_sec)}–{formatTime(cut.end_sec)}
                </Button>
              </HStack>
              <Text fontSize="sm" color="gray.800" lineHeight="1.6">
                {cut.summary}
              </Text>

              {cut.concepts.length > 0 && (
                <ConceptList concepts={cut.concepts} segmentId={cut.segment_id} />
              )}
            </Box>
          ))}
        </VStack>
      )}

      <Box
        as="details"
        borderWidth="1px"
        borderColor="#e2e3e6"
        borderRadius="13px"
        bg="#fafafa"
      >
        <Flex
          as="summary"
          cursor="pointer"
          align="center"
          justify="space-between"
          px={3}
          py={2.5}
          fontSize="sm"
          fontWeight="semibold"
          color="gray.700"
        >
          <HStack gap={2}>
            <Check size={15} color="#16a34a" />
            <Text>Already known ({data.stats.known})</Text>
          </HStack>
          <ChevronDown size={15} />
        </Flex>
        <VStack align="stretch" gap={0} px={3} pb={3}>
          {data.known_concepts.length === 0 ? (
            <Text fontSize="xs" color="gray.500">No known concepts were returned.</Text>
          ) : (
            data.known_concepts.map((concept) => (
              <Box
                key={`${concept.name}-${concept.source || ""}`}
                py={2}
                borderTopWidth="1px"
                borderColor="gray.200"
              >
                <Text fontSize="xs" fontWeight="semibold" color="gray.800">
                  {concept.name}
                </Text>
                <Text fontSize="xs" color="gray.500">
                  Covered by “{noteName(concept.source)}”
                </Text>
                {concept.goal_note && (
                  <Text mt={0.5} fontSize="xs" color="blue.600">
                    {concept.goal_note}
                  </Text>
                )}
              </Box>
            ))
          )}
        </VStack>
      </Box>

      {quizOpen ? (
        <QuizFlow
          videoId={data.video.id}
          onComplete={(result) => {
            setQuizOpen(false);
            setCaptured(result.captured);
            void loadDelta();
          }}
          onClose={() => setQuizOpen(false)}
        />
      ) : (
        <Button
          colorPalette="purple"
          size="md"
          h="44px"
          borderRadius="11px"
          boxShadow="0 6px 16px rgba(98,91,246,0.20)"
          // Knowledge has to be demonstrated, not asserted: the quiz decides what
          // gets captured. The fixture has no backend to grade against.
          onClick={() => (isFixture ? void captureLearnings() : setQuizOpen(true))}
          loading={capturing}
          disabled={quizzableConcepts.length === 0}
          title={
            quizzableConcepts.length === 0
              ? "Nothing here to capture — this video taught no concept you don't already have."
              : undefined
          }
        >
          <Sparkles size={15} />
          Capture learnings
        </Button>
      )}

      {captured && (
        <Box p={3} borderWidth="1px" borderColor="green.200" borderRadius="xl" bg="green.50">
          <HStack gap={2} mb={captured.length ? 2 : 0}>
            <Check size={15} color="#15803d" />
            <Text fontSize="xs" fontWeight="bold" color="green.700">
              {captured.length
                ? `Captured ${captured.length} concept${captured.length === 1 ? "" : "s"}`
                : "Nothing new to capture"}
            </Text>
          </HStack>
          {captured.length > 0 && (
            <HStack gap={1.5} flexWrap="wrap">
              {captured.map((concept) => (
                <Badge key={concept} colorPalette="green" variant="subtle">{concept}</Badge>
              ))}
            </HStack>
          )}
        </Box>
      )}

      {captureError && (
        <Box p={3} borderWidth="1px" borderColor="orange.200" borderRadius="xl" bg="orange.50">
          <HStack align="start" gap={2}>
            <Clock3 size={14} color="#c2410c" />
            <Text fontSize="xs" color="orange.700">{captureError}</Text>
          </HStack>
        </Box>
      )}
    </VStack>
  );
}
