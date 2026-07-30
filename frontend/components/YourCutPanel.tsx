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

  return (
    <VStack align="stretch" gap={3} pb={3}>
      <Box
        p={4}
        borderRadius="xl"
        color="white"
        background="linear-gradient(135deg, #111827 0%, #312e81 55%, #1d4ed8 100%)"
        boxShadow="md"
      >
        <HStack justify="space-between" mb={2}>
          <Text fontSize="xs" fontWeight="bold" letterSpacing="0.16em" color="purple.100">
            YOUR CUT
          </Text>
          <HStack gap={1.5}>
            {isFixture && (
              <Badge colorPalette="purple" variant="solid" size="sm">Fixture preview</Badge>
            )}
            <Badge colorPalette="green" variant="solid" size="sm">{skipPercent}% skipped</Badge>
          </HStack>
        </HStack>
        <Heading size="lg" lineHeight="1.1">
          Watch {formatTime(data.stats.watch_sec)} of {formatTime(totalSeconds)}
        </Heading>
        <Text mt={2} fontSize="sm" color="blue.100">
          You already know the rest.
        </Text>
        <HStack mt={4} gap={2} flexWrap="wrap">
          <Badge colorPalette="orange" variant="solid">
            {data.stats.novel} novel
          </Badge>
          <Badge colorPalette="blue" variant="solid">
            {data.stats.goal_hits} learning goals
          </Badge>
          <Badge colorPalette="gray" variant="solid">
            {data.stats.known} already known
          </Badge>
        </HStack>
      </Box>

      {data.cuts.length === 0 ? (
        <Box p={5} textAlign="center" borderWidth="1px" borderRadius="lg" bg="green.50">
          <Text fontSize="sm" fontWeight="semibold" color="green.700">
            Nothing new for you in this video — skip it entirely 🎉
          </Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={2}>
          {data.cuts.map((cut, index) => (
            <Box
              key={cut.segment_id}
              p={3}
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="lg"
              bg="white"
              boxShadow="xs"
            >
              <HStack justify="space-between" align="start" mb={2}>
                <Text fontSize="xs" fontWeight="bold" color="gray.500">
                  CUT {index + 1}
                </Text>
                <Button
                  size="xs"
                  variant="subtle"
                  colorPalette="purple"
                  onClick={() => onSeek?.(cut.start_sec)}
                >
                  <Play size={11} />
                  {formatTime(cut.start_sec)}–{formatTime(cut.end_sec)}
                </Button>
              </HStack>
              <Text fontSize="sm" color="gray.800" lineHeight="1.45">
                {cut.summary}
              </Text>
              <VStack align="stretch" gap={1.5} mt={3}>
                {cut.concepts.map((concept) => {
                  const isGoal = concept.status === "goal";
                  return (
                    <Box
                      key={`${cut.segment_id}-${concept.name}`}
                      px={2.5}
                      py={2}
                      borderRadius="md"
                      bg={isGoal ? "blue.50" : "orange.50"}
                      borderLeftWidth="3px"
                      borderLeftColor={isGoal ? "blue.400" : "orange.400"}
                    >
                      <Badge colorPalette={isGoal ? "blue" : "orange"} variant="solid">
                        {concept.name}
                      </Badge>
                      <Text mt={1} fontSize="xs" color={isGoal ? "blue.700" : "orange.700"}>
                        {concept.why || (isGoal ? "you asked to learn this" : "not in your knowledge base")}
                      </Text>
                    </Box>
                  );
                })}
              </VStack>
            </Box>
          ))}
        </VStack>
      )}

      <Box as="details" borderWidth="1px" borderColor="gray.200" borderRadius="lg" bg="gray.50">
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
              </Box>
            ))
          )}
        </VStack>
      </Box>

      <Button
        colorPalette="purple"
        size="sm"
        onClick={() => void captureLearnings()}
        loading={capturing}
        disabled={novelConcepts.length === 0}
      >
        <Sparkles size={15} />
        Capture learnings
      </Button>

      {captured && (
        <Box p={3} borderWidth="1px" borderColor="green.200" borderRadius="lg" bg="green.50">
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
        <Box p={3} borderWidth="1px" borderColor="orange.200" borderRadius="lg" bg="orange.50">
          <HStack align="start" gap={2}>
            <Clock3 size={14} color="#c2410c" />
            <Text fontSize="xs" color="orange.700">{captureError}</Text>
          </HStack>
        </Box>
      )}
    </VStack>
  );
}
