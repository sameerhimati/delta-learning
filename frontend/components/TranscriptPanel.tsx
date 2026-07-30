"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Check, Play, ScrollText, Type } from "lucide-react";
import { API_BASE, CONCEPT_STATUS_COLORS } from "@/lib/config";

export interface TranscriptRange {
  start_sec: number;
  end_sec: number;
}

interface TranscriptSegment {
  id: string;
  idx: number;
  start_sec: number | null;
  end_sec: number | null;
  summary: string;
  on_screen_text: string;
  transcript: string;
  entities: string[];
  topics: string[];
  known_concepts: string[];
}

interface SegmentsResponse {
  video_id: string;
  segments: TranscriptSegment[];
}

interface TranscriptPanelProps {
  videoId: string;
  /** A single highlighted range, e.g. the cut the viewer is reading. */
  highlight?: TranscriptRange | null;
  /** Several highlighted ranges, e.g. every cut in "Your Cut". */
  highlights?: TranscriptRange[];
  onSeek?: (seconds: number) => void;
  maxH?: string;
}

function formatTime(seconds: number | null): string {
  if (seconds == null) return "--:--";
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function overlaps(segment: TranscriptSegment, range: TranscriptRange): boolean {
  const start = segment.start_sec ?? 0;
  const end = segment.end_sec ?? start;
  return start < range.end_sec && end > range.start_sec;
}

export function TranscriptPanel({
  videoId,
  highlight,
  highlights,
  onSeek,
  maxH = "560px",
}: TranscriptPanelProps) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstHighlightRef = useRef<HTMLDivElement>(null);

  const loadSegments = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSegments([]);
    try {
      const response = await fetch(
        `${API_BASE}/videos/${encodeURIComponent(videoId)}/segments`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok) {
        throw new Error(`Transcript request failed (${response.status})`);
      }
      const payload = (await response.json()) as SegmentsResponse;
      setSegments(payload.segments || []);
    } catch (requestError) {
      setSegments([]);
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to load this transcript.",
      );
    } finally {
      setLoading(false);
    }
  }, [videoId]);

  useEffect(() => {
    void loadSegments();
  }, [loadSegments]);

  const ranges = useMemo(() => {
    const merged = [...(highlights || [])];
    if (highlight) merged.push(highlight);
    return merged;
  }, [highlight, highlights]);

  // Only blocks with something to read; a segment with neither transcript nor
  // summary would render as an empty shell.
  const readable = useMemo(
    () =>
      [...segments]
        .filter((segment) => (segment.transcript || segment.summary || "").trim())
        .sort((a, b) => a.idx - b.idx),
    [segments],
  );

  const highlightedIds = useMemo(() => {
    if (ranges.length === 0) return new Set<string>();
    return new Set(
      readable
        .filter((segment) => ranges.some((range) => overlaps(segment, range)))
        .map((segment) => segment.id),
    );
  }, [readable, ranges]);

  const firstHighlightId = useMemo(() => {
    const match = readable.find((segment) => highlightedIds.has(segment.id));
    return match?.id || null;
  }, [readable, highlightedIds]);

  // Scroll the highlighted range into view inside this container only — never
  // move the page.
  useEffect(() => {
    const container = scrollRef.current;
    const target = firstHighlightRef.current;
    if (!container || !target || !firstHighlightId) return;
    container.scrollTo({
      top: Math.max(0, target.offsetTop - container.offsetTop - 8),
      behavior: "smooth",
    });
  }, [firstHighlightId]);

  if (loading) {
    return (
      <Flex minH="220px" align="center" justify="center" direction="column" gap={3}>
        <Spinner size="sm" color="purple.500" />
        <Text fontSize="xs" color="gray.500">Loading the full transcript…</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Box p={4} borderWidth="1px" borderColor="red.200" borderRadius="lg" bg="red.50">
        <Heading size="sm" color="red.700">Transcript unavailable</Heading>
        <Text mt={1} fontSize="xs" color="red.600">{error}</Text>
        <Button
          mt={3}
          size="xs"
          variant="outline"
          colorPalette="red"
          onClick={() => void loadSegments()}
        >
          Try again
        </Button>
      </Box>
    );
  }

  const lastSegment = readable[readable.length - 1];
  const totalSeconds = lastSegment?.end_sec ?? null;

  return (
    <Box
      borderWidth="1px"
      borderColor="#e1e2e5"
      borderRadius="14px"
      bg="white"
      overflow="hidden"
      boxShadow="0 1px 2px rgba(17,24,39,0.035), 0 8px 24px rgba(17,24,39,0.035)"
    >
      <HStack
        px={4}
        py={3.5}
        justify="space-between"
        align="start"
        borderBottomWidth="1px"
        borderColor="#e8e9eb"
      >
        <HStack gap={2}>
          <ScrollText size={16} color="#625bf6" />
          <Box>
            <Heading size="sm">Full transcript</Heading>
            <Text mt={0.5} fontSize="10px" color="gray.400">
              {readable.length} {readable.length === 1 ? "section" : "sections"}
              {totalSeconds ? ` · ${formatTime(totalSeconds)} total` : ""}
              {onSeek ? " · click a timecode to jump" : ""}
            </Text>
          </Box>
        </HStack>
        {highlightedIds.size > 0 && (
          <Badge colorPalette="purple" variant="subtle" borderRadius="full" flexShrink={0}>
            {highlightedIds.size} in your cut
          </Badge>
        )}
      </HStack>

      {readable.length === 0 ? (
        <Box px={4} py={8} textAlign="center">
          <Text fontSize="sm" fontWeight="semibold" color="gray.700">
            No transcript for this video yet
          </Text>
          <Text mt={1} fontSize="xs" color="gray.500">
            Its segments were indexed without spoken text.
          </Text>
        </Box>
      ) : (
        <Box ref={scrollRef} maxH={maxH} overflowY="auto" overflowX="hidden">
          <VStack align="stretch" gap={0}>
            {readable.map((segment, index) => {
              const isHighlighted = highlightedIds.has(segment.id);
              const body = (segment.transcript || "").trim();
              const isFallback = body.length === 0;
              return (
                <Box
                  key={segment.id}
                  ref={segment.id === firstHighlightId ? firstHighlightRef : undefined}
                  px={4}
                  py={3.5}
                  borderTopWidth={index === 0 ? 0 : "1px"}
                  borderColor="#eceded"
                  borderLeftWidth="3px"
                  borderLeftColor={isHighlighted ? "#625bf6" : "transparent"}
                  bg={isHighlighted ? "#f8f7ff" : "white"}
                  transition="background 0.15s ease"
                >
                  <HStack justify="space-between" align="center" gap={3} mb={2}>
                    <HStack gap={2} minW={0}>
                      {onSeek ? (
                        <Button
                          size="xs"
                          variant="subtle"
                          colorPalette={isHighlighted ? "purple" : "gray"}
                          borderRadius="full"
                          flexShrink={0}
                          onClick={() => onSeek(segment.start_sec ?? 0)}
                        >
                          <Play size={10} />
                          {formatTime(segment.start_sec)}
                        </Button>
                      ) : (
                        <Text
                          flexShrink={0}
                          fontSize="xs"
                          fontFamily="mono"
                          fontWeight="semibold"
                          color={isHighlighted ? "purple.600" : "gray.500"}
                        >
                          {formatTime(segment.start_sec)}
                        </Text>
                      )}
                      <Text fontSize="10px" color="gray.400" flexShrink={0}>
                        – {formatTime(segment.end_sec)}
                      </Text>
                    </HStack>
                    {isHighlighted && (
                      <Badge
                        colorPalette="purple"
                        variant="solid"
                        borderRadius="full"
                        fontSize="10px"
                        flexShrink={0}
                      >
                        In your cut
                      </Badge>
                    )}
                  </HStack>

                  <Text
                    fontSize="sm"
                    lineHeight="1.75"
                    color={isFallback ? "gray.600" : "gray.800"}
                    fontStyle={isFallback ? "italic" : "normal"}
                    overflowWrap="anywhere"
                  >
                    {isFallback ? segment.summary.trim() : body}
                  </Text>
                  {isFallback && (
                    <Text mt={1} fontSize="10px" color="gray.400">
                      No spoken text captured here — showing the visual summary.
                    </Text>
                  )}

                  {segment.on_screen_text?.trim() && (
                    <HStack
                      mt={2.5}
                      px={2.5}
                      py={1.5}
                      gap={2}
                      align="start"
                      borderWidth="1px"
                      borderColor="#e8e9eb"
                      borderRadius="8px"
                      bg="#fafafa"
                    >
                      <Box mt={0.5} flexShrink={0}>
                        <Type size={11} color="#9aa0a6" />
                      </Box>
                      <Text fontSize="10px" color="gray.500" overflowWrap="anywhere">
                        {segment.on_screen_text.trim()}
                      </Text>
                    </HStack>
                  )}

                  {segment.known_concepts?.length > 0 && (
                    <Flex mt={2.5} gap={1.5} flexWrap="wrap" align="center">
                      <Check size={11} color={CONCEPT_STATUS_COLORS.known} />
                      {segment.known_concepts.slice(0, 6).map((concept) => (
                        <Badge
                          key={`${segment.id}-${concept}`}
                          colorPalette="green"
                          variant="subtle"
                          borderRadius="full"
                          fontSize="10px"
                        >
                          {concept}
                        </Badge>
                      ))}
                      {segment.known_concepts.length > 6 && (
                        <Text fontSize="10px" color="gray.400">
                          +{segment.known_concepts.length - 6} more you know
                        </Text>
                      )}
                    </Flex>
                  )}
                </Box>
              );
            })}
          </VStack>
        </Box>
      )}
    </Box>
  );
}

export default TranscriptPanel;
