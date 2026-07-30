"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Check, ChevronDown, Clock3, Sparkles } from "lucide-react";
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

function noteName(source?: string | null): string {
  if (!source) return "your knowledge vault";
  return source.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || source;
}

// Same hexes ContextGraphView uses, so a concept reads the same colour everywhere.
const STATUS_COLOR = {
  novel: "#f97316",
  goal: "#3b82f6",
  known: "#22c55e",
} as const;

// A dot and two weights of text carry status without a bordered pill per concept.
function ConceptLine({ concept }: { concept: DeltaConcept }) {
  const isGoal = concept.status === "goal";
  return (
    <HStack gap={2.5} align="baseline">
      <Box
        w="6px"
        h="6px"
        mt="1px"
        flexShrink={0}
        borderRadius="full"
        bg={isGoal ? STATUS_COLOR.goal : STATUS_COLOR.novel}
      />
      <Text fontSize="xs" fontWeight="semibold" color="ink">
        {concept.name}
      </Text>
      <Text fontSize="xs" color="gray.400">
        {concept.why ||
          (isGoal ? "you asked to learn this" : "not in your knowledge base")}
      </Text>
    </HStack>
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
    : "You already know the rest.";

  return (
    <VStack align="stretch" gap={8} pb={3}>
      <Box as="section" aria-label="Your cut">
        <HStack justify="space-between" align="baseline" mb={4}>
          <Text
            fontSize="11px"
            fontWeight="semibold"
            letterSpacing="0.14em"
            color="gray.400"
          >
            YOUR CUT
          </Text>
          {isFixture && (
            <Text fontSize="11px" color="gray.400">
              Fixture preview
            </Text>
          )}
        </HStack>

        <Heading
          fontSize={{ base: "38px", lg: "54px" }}
          fontWeight="semibold"
          lineHeight="1"
          letterSpacing="-0.045em"
          color="ink"
        >
          Watch {formatTime(data.stats.watch_sec)}
        </Heading>
        <Text mt={3} maxW="62ch" fontSize={{ base: "sm", lg: "md" }} color="gray.500">
          of {formatTime(totalSeconds)} — {recommendationExplanation}
        </Text>

        <Box mt={8} maxW="620px">
          <Flex h="3px" overflow="hidden" borderRadius="full" bg="#e6e6ea">
            <Box
              w={`${Math.max(0, 100 - skipPercent)}%`}
              minW={data.stats.watch_sec > 0 ? "3px" : 0}
              bg="ink"
            />
          </Flex>
          <HStack justify="space-between" mt={2.5}>
            <Text fontSize="xs" fontWeight="medium" color="ink">
              Study {100 - skipPercent}%
            </Text>
            <Text fontSize="xs" color="gray.400">
              Skip {skipPercent}%
            </Text>
          </HStack>
        </Box>

        <Flex mt={7} flexWrap="wrap" rowGap={3}>
          {[
            { value: data.stats.novel, label: "new", color: STATUS_COLOR.novel },
            { value: data.stats.goal_hits, label: "goal matches", color: STATUS_COLOR.goal },
            { value: data.stats.known, label: "already known", color: STATUS_COLOR.known },
          ].map((stat, index) => (
            <HStack
              key={stat.label}
              gap={2}
              pl={index === 0 ? 0 : 5}
              pr={5}
              borderLeftWidth={index === 0 ? 0 : "1px"}
              borderColor="line"
            >
              <Box w="6px" h="6px" borderRadius="full" bg={stat.color} />
              <Text fontSize="sm" color="gray.500">
                <Text as="span" fontWeight="semibold" color="ink">
                  {stat.value}
                </Text>{" "}
                {stat.label}
              </Text>
            </HStack>
          ))}
        </Flex>
      </Box>

      {data.cuts.length === 0 ? (
        <Box py={2} borderTopWidth="1px" borderColor="line">
          <HStack gap={2.5} mt={5}>
            <Box w="6px" h="6px" borderRadius="full" bg={STATUS_COLOR.known} />
            <Text fontSize="sm" fontWeight="semibold" color="ink">
              Nothing new for you in this video — skip it entirely.
            </Text>
          </HStack>
          <Text mt={1.5} ml={4.5} fontSize="sm" color="gray.500">
            Your saved knowledge already covers every concept we found.
          </Text>
        </Box>
      ) : (
        <Box as="section" aria-label="Recommended clips">
          <HStack
            justify="space-between"
            align="baseline"
            pb={3}
            borderBottomWidth="1px"
            borderColor="ink"
          >
            <Heading size="sm" color="ink" letterSpacing="-0.01em">
              Recommended clips
            </Heading>
            <Text fontSize="xs" color="gray.400">
              {data.cuts.length} {data.cuts.length === 1 ? "section" : "sections"}, in order
            </Text>
          </HStack>

          {data.cuts.map((cut, index) => (
            <Box
              key={cut.segment_id}
              py={5}
              borderBottomWidth="1px"
              borderColor="line"
            >
              <HStack gap={3} mb={2.5} align="baseline">
                <Text fontSize="xs" fontFamily="mono" color="gray.400">
                  {String(index + 1).padStart(2, "0")}
                </Text>
                <Button
                  variant="plain"
                  h="auto"
                  p={0}
                  fontSize="xs"
                  fontWeight="semibold"
                  color="brand.500"
                  _hover={{ color: "brand.700" }}
                  onClick={() => onSeek?.(cut.start_sec)}
                >
                  {formatTime(cut.start_sec)}–{formatTime(cut.end_sec)}
                </Button>
              </HStack>
              <Text fontSize="sm" color="gray.700" lineHeight="1.7" maxW="68ch">
                {cut.summary}
              </Text>

              {cut.concepts.length > 0 && (
                <>
                  <VStack align="stretch" gap={1.5} mt={3.5}>
                    {cut.concepts.slice(0, 6).map((concept) => (
                      <ConceptLine
                        key={`${cut.segment_id}-${concept.name}`}
                        concept={concept}
                      />
                    ))}
                  </VStack>
                  {cut.concepts.length > 6 && (
                    <Box as="details" mt={2.5}>
                      <Text
                        as="summary"
                        cursor="pointer"
                        fontSize="xs"
                        fontWeight="medium"
                        color="brand.500"
                      >
                        Show {cut.concepts.length - 6} more concepts
                      </Text>
                      <VStack align="stretch" gap={1.5} mt={2.5}>
                        {cut.concepts.slice(6).map((concept) => (
                          <ConceptLine
                            key={`${cut.segment_id}-${concept.name}`}
                            concept={concept}
                          />
                        ))}
                      </VStack>
                    </Box>
                  )}
                </>
              )}
            </Box>
          ))}
        </Box>
      )}

      <Box as="details">
        <Flex
          as="summary"
          cursor="pointer"
          align="center"
          justify="space-between"
          py={3}
          borderTopWidth="1px"
          borderColor="line"
          fontSize="sm"
          fontWeight="medium"
          color="gray.600"
          _hover={{ color: "ink" }}
        >
          <HStack gap={2.5}>
            <Box w="6px" h="6px" borderRadius="full" bg={STATUS_COLOR.known} />
            <Text>Already known ({data.stats.known})</Text>
          </HStack>
          <ChevronDown size={15} />
        </Flex>
        <VStack align="stretch" gap={0} pb={3}>
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
          alignSelf="flex-start"
          px={6}
          borderRadius="control"
          // Knowledge has to be demonstrated, not asserted: the quiz decides what
          // gets captured. The fixture has no backend to grade against.
          onClick={() => (isFixture ? void captureLearnings() : setQuizOpen(true))}
          loading={capturing}
          disabled={novelConcepts.length === 0}
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
