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

function ConceptPill({ concept }: { concept: DeltaConcept }) {
  const isGoal = concept.status === "goal";
  return (
    <Box
      px={2.5}
      py={2}
      borderWidth="1px"
      borderColor={isGoal ? "blue.200" : "orange.200"}
      borderRadius="lg"
      bg={isGoal ? "blue.50" : "orange.50"}
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

export function YourCutPanel({ videoId, useFixture = false, onSeek }: YourCutPanelProps) {
  const [data, setData] = useState<DeltaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFixture, setIsFixture] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState<string[] | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

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
    <VStack align="stretch" gap={4} pb={3}>
      <Box
        p={{ base: 4, lg: 5 }}
        borderRadius="2xl"
        color="white"
        background="linear-gradient(145deg, #171922 0%, #252945 65%, #30366b 100%)"
        boxShadow="0 12px 32px rgba(17,19,24,0.16)"
      >
        <HStack justify="space-between" align="start" mb={4}>
          <Box>
            <Text fontSize="xs" fontWeight="bold" letterSpacing="0.14em" color="purple.200">
              YOUR CUT
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
              colorPalette={skipPercent === 0 ? "orange" : "green"}
              variant="solid"
              size="sm"
            >
              {skipPercent}% skipped
            </Badge>
          </HStack>
        </HStack>

        <Heading
          fontSize={{ base: "2xl", lg: "3xl" }}
          lineHeight="1.05"
          letterSpacing="-0.035em"
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

        <Grid templateColumns="repeat(3, minmax(0, 1fr))" gap={2} mt={5}>
          {[
            { value: data.stats.novel, label: "new concepts", color: "orange.300" },
            { value: data.stats.goal_hits, label: "goal matches", color: "blue.300" },
            { value: data.stats.known, label: "already known", color: "green.300" },
          ].map((stat) => (
            <Box
              key={stat.label}
              px={{ base: 2, md: 3 }}
              py={2.5}
              bg="whiteAlpha.100"
              borderWidth="1px"
              borderColor="whiteAlpha.200"
              borderRadius="xl"
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
          borderColor="green.200"
          borderRadius="xl"
          bg="green.50"
        >
          <Text fontSize="sm" fontWeight="semibold" color="green.800">
            Nothing new for you in this video — skip it entirely 🎉
          </Text>
          <Text mt={1} fontSize="xs" color="green.700">
            Your saved knowledge already covers every concept we found.
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
              <Badge colorPalette="orange" variant="subtle">new</Badge>
              <Badge colorPalette="blue" variant="subtle">your goal</Badge>
            </HStack>
          </HStack>

          {data.cuts.map((cut, index) => (
            <Box
              key={cut.segment_id}
              p={{ base: 3, md: 4 }}
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="xl"
              bg="white"
              transition="border-color 0.15s ease, box-shadow 0.15s ease"
              _hover={{ borderColor: "purple.200", boxShadow: "0 4px 16px rgba(15,23,42,0.05)" }}
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
                  <Text fontSize="xs" fontWeight="bold" letterSpacing="0.08em" color="gray.500">
                    STUDY CLIP
                  </Text>
                </HStack>
                <Button
                  size="xs"
                  variant="outline"
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
                <>
                  <Flex gap={2} mt={3} flexWrap="wrap">
                    {cut.concepts.slice(0, 6).map((concept) => (
                      <ConceptPill
                        key={`${cut.segment_id}-${concept.name}`}
                        concept={concept}
                      />
                    ))}
                  </Flex>
                  {cut.concepts.length > 6 && (
                    <Box as="details" mt={2}>
                      <Text
                        as="summary"
                        cursor="pointer"
                        fontSize="xs"
                        fontWeight="semibold"
                        color="purple.600"
                      >
                        Show {cut.concepts.length - 6} more concepts
                      </Text>
                      <Flex gap={2} mt={2} flexWrap="wrap">
                        {cut.concepts.slice(6).map((concept) => (
                          <ConceptPill
                            key={`${cut.segment_id}-${concept.name}`}
                            concept={concept}
                          />
                        ))}
                      </Flex>
                    </Box>
                  )}
                </>
              )}
            </Box>
          ))}
        </VStack>
      )}

      <Box as="details" borderWidth="1px" borderColor="gray.200" borderRadius="xl" bg="#fbfbfc">
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

      <Button
        colorPalette="purple"
        size="md"
        borderRadius="xl"
        onClick={() => void captureLearnings()}
        loading={capturing}
        disabled={novelConcepts.length === 0}
      >
        <Sparkles size={15} />
        Capture learnings
      </Button>

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
