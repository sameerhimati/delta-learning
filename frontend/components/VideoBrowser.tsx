"use client";

import { useEffect, useRef, useState } from "react";
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
import {
  ArrowLeft,
  ChevronDown,
  Clock3,
  Film,
  Library,
  Play,
} from "lucide-react";
import { API_BASE, NODE_COLORS } from "@/lib/config";
import { DELTA_FIXTURE, YourCutPanel } from "@/components/YourCutPanel";
import { StudyNotes } from "@/components/StudyNotes";

interface Video {
  id: string;
  title: string;
  url: string;
  duration_sec: number | null;
  summary: string;
  segment_count: number;
}

interface Segment {
  id: string;
  start_sec: number | null;
  end_sec: number | null;
  summary: string;
  on_screen_text: string;
  entities: string[];
}

const FIXTURE_VIDEO: Video = {
  id: DELTA_FIXTURE.video.id,
  title: DELTA_FIXTURE.video.title,
  url: "",
  duration_sec: DELTA_FIXTURE.video.duration_sec,
  summary: "Personalized cut preview using the frozen Delta Learning API contract.",
  segment_count: DELTA_FIXTURE.cuts.length,
};

function fmt(sec: number | null): string {
  if (sec == null) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function durationLabel(sec: number | null): string {
  if (!sec) return "Length unavailable";
  const minutes = Math.max(1, Math.round(sec / 60));
  return `${minutes} min`;
}

function displayTitle(title: string): string {
  return title.replace(/_s_/g, "'s ").replaceAll("_", " ");
}

export function VideoBrowser() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Video | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segLoading, setSegLoading] = useState(false);
  const [usingFixture, setUsingFixture] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch(`${API_BASE}/videos`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          throw new Error(`Video list request failed (${response.status})`);
        }
        const data = await response.json();
        const loadedVideos = (data.videos || []) as Video[];
        if (loadedVideos.length === 0) {
          throw new Error("No live videos are available yet");
        }
        const initialVideo =
          loadedVideos.find((video) => displayTitle(video.title).startsWith("L8 ")) ||
          loadedVideos[0];
        setVideos(loadedVideos);
        setSelected(initialVideo);
        void loadSegments(initialVideo);
      } catch {
        setVideos([FIXTURE_VIDEO]);
        setSelected(FIXTURE_VIDEO);
        setUsingFixture(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function loadSegments(video: Video) {
    setSegments([]);
    setSegLoading(true);
    try {
      const response = await fetch(
        `${API_BASE}/videos/${encodeURIComponent(video.id)}/segments`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok) {
        throw new Error(`Segments request failed (${response.status})`);
      }
      const data = await response.json();
      setSegments(data.segments || []);
    } catch {
      setSegments([]);
    } finally {
      setSegLoading(false);
    }
  }

  function openVideo(video: Video) {
    setSelected(video);
    if (usingFixture && video.id === FIXTURE_VIDEO.id) {
      setSegments([]);
      setSegLoading(false);
      return;
    }
    void loadSegments(video);
  }

  function seekTo(sec: number | null) {
    if (sec == null || !videoRef.current) return;
    videoRef.current.currentTime = sec;
    videoRef.current.play().catch(() => {});
  }

  if (loading) {
    return (
      <Flex h="100%" align="center" justify="center" direction="column" gap={3}>
        <Spinner size="sm" color="purple.500" />
        <Text fontSize="sm" color="gray.500">Building your study queue…</Text>
      </Flex>
    );
  }

  return (
    <Flex h="100%" minW={0} overflow="hidden">
      <Flex
        as="aside"
        aria-label="Study queue"
        direction="column"
        w={{ base: "100%", md: "256px" }}
        flexShrink={0}
        borderRightWidth={{ base: 0, md: "1px" }}
        borderColor="#e4e5e8"
        bg="#f8f8f9"
        display={{ base: selected ? "none" : "flex", md: "flex" }}
      >
        <Box px={4} pt={4} pb={3.5} borderBottomWidth="1px" borderColor="#e4e5e8">
          <HStack gap={2} mb={1}>
            <Library size={16} color="#625bf6" />
            <Heading size="sm">Study queue</Heading>
          </HStack>
          <Text fontSize="xs" color="gray.500">
            {videos.length} {videos.length === 1 ? "talk" : "talks"} ready for your delta
          </Text>
        </Box>

        <Box flex={1} overflow="auto" p={3}>
          {videos.length === 0 ? (
            <Flex
              direction="column"
              align="center"
              justify="center"
              py={12}
              gap={3}
              color="gray.400"
            >
              <Film size={28} />
              <Text fontSize="sm" textAlign="center">
                No videos are ready yet.
              </Text>
            </Flex>
          ) : (
            <VStack align="stretch" gap={2}>
              {videos.map((video, index) => {
                const isSelected = selected?.id === video.id;
                return (
                  <Box
                    as="button"
                    key={video.id}
                    w="100%"
                    p={3}
                    textAlign="left"
                    borderWidth="1px"
                    borderColor={isSelected ? "#cbc8fb" : "#e3e4e7"}
                    borderRadius="12px"
                    bg="white"
                    boxShadow={
                      isSelected
                        ? "0 1px 2px rgba(17,24,39,0.04), 0 5px 14px rgba(17,24,39,0.06)"
                        : "0 1px 1px rgba(17,24,39,0.02)"
                    }
                    cursor="pointer"
                    transition="all 0.15s ease"
                    _hover={{ borderColor: "#b8b4f8", transform: "translateY(-1px)" }}
                    onClick={() => openVideo(video)}
                  >
                    <HStack justify="space-between" align="start" gap={3}>
                      <Flex
                        align="center"
                        justify="center"
                        w={7}
                        h={7}
                        flexShrink={0}
                        borderRadius="9px"
                        bg={isSelected ? "#625bf6" : "#edeef0"}
                        color={isSelected ? "white" : "gray.500"}
                        fontSize="xs"
                        fontWeight="bold"
                      >
                        {index + 1}
                      </Flex>
                      <Box flex={1} minW={0}>
                        <Text
                          fontSize="sm"
                          fontWeight="semibold"
                          lineHeight="1.35"
                          color="gray.900"
                        >
                          {displayTitle(video.title)}
                        </Text>
                        <HStack gap={2} mt={2} color="gray.500">
                          <Clock3 size={12} />
                          <Text fontSize="xs">{durationLabel(video.duration_sec)}</Text>
                          <Text fontSize="xs">·</Text>
                          <Text fontSize="xs">{video.segment_count} sections</Text>
                        </HStack>
                      </Box>
                    </HStack>
                  </Box>
                );
              })}
            </VStack>
          )}
        </Box>
      </Flex>

      <Box
        flex={1}
        minW={0}
        h="100%"
        overflow="auto"
        display={{ base: selected ? "block" : "none", md: "block" }}
        bg="white"
      >
        {selected ? (
          <>
            <Box
              px={{ base: 4, lg: 7 }}
              pt={{ base: 4, lg: 5 }}
              pb={{ base: 4, lg: 4.5 }}
              borderBottomWidth="1px"
              borderColor="#e6e7e9"
            >
              <Button
                display={{ base: "inline-flex", md: "none" }}
                size="xs"
                variant="ghost"
                mb={3}
                ml={-2}
                onClick={() => setSelected(null)}
              >
                <ArrowLeft size={14} />
                Study queue
              </Button>
              <HStack gap={2} mb={1.5}>
                <Box w={1.5} h={1.5} borderRadius="full" bg="#625bf6" />
                <Text
                  fontSize="10px"
                  fontWeight="bold"
                  letterSpacing="0.13em"
                  color="purple.600"
                >
                  NOW STUDYING
                </Text>
                <Text fontSize="10px" color="gray.400">·</Text>
                <Text fontSize="10px" fontWeight="medium" color="gray.500">
                  {durationLabel(selected.duration_sec)}
                </Text>
              </HStack>
              <Heading
                maxW="900px"
                fontSize={{ base: "xl", lg: "25px" }}
                lineHeight="1.18"
                letterSpacing="-0.035em"
              >
                {displayTitle(selected.title)}
              </Heading>
              {selected.summary && (
                <Text maxW="900px" mt={1.5} fontSize="xs" color="gray.500" lineHeight="1.6">
                  {selected.summary}
                </Text>
              )}
              {selected.url && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  ref={videoRef}
                  src={selected.url}
                  controls
                  style={{ width: "100%", maxWidth: 900, marginTop: 16, borderRadius: 12 }}
                />
              )}
            </Box>

            <Flex
              align="flex-start"
              direction={{ base: "column", xl: "row" }}
              gap={6}
              px={{ base: 4, lg: 5 }}
              py={{ base: 5, lg: 5 }}
              maxW="1180px"
              mx="auto"
            >
              <Box flex={1} minW={0} w="100%">
                <YourCutPanel
                  videoId={selected.id}
                  useFixture={usingFixture && selected.id === FIXTURE_VIDEO.id}
                  onSeek={seekTo}
                />

                {!usingFixture && (
                  <Box
                    as="details"
                    mt={4}
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="xl"
                    bg="white"
                  >
                    <Flex
                      as="summary"
                      cursor="pointer"
                      align="center"
                      justify="space-between"
                      px={4}
                      py={3}
                      fontSize="sm"
                      fontWeight="semibold"
                      color="gray.700"
                    >
                      <HStack gap={2}>
                        <Film size={15} color="#6b7280" />
                        <Text>
                          Full transcript
                          {segments.length ? ` · ${segments.length} sections` : ""}
                        </Text>
                        {segLoading && <Spinner size="xs" />}
                      </HStack>
                      <ChevronDown size={15} />
                    </Flex>
                    <VStack align="stretch" gap={2} px={3} pb={3}>
                      {segments.map((segment) => (
                        <Box
                          key={segment.id}
                          p={3}
                          bg="#fbfbfc"
                          borderRadius="lg"
                          borderWidth="1px"
                          borderColor="gray.200"
                          cursor="pointer"
                          _hover={{ borderColor: "purple.300", bg: "purple.50" }}
                          onClick={() => seekTo(segment.start_sec)}
                        >
                          <Badge size="sm" colorPalette="purple" variant="subtle">
                            <Play size={9} /> {fmt(segment.start_sec)}–{fmt(segment.end_sec)}
                          </Badge>
                          <Text mt={2} fontSize="sm" color="gray.700" lineHeight="1.5">
                            {segment.summary}
                          </Text>
                          {segment.entities?.length > 0 && (
                            <HStack gap={1} mt={2} flexWrap="wrap">
                              {segment.entities.filter(Boolean).map((entity) => (
                                <Badge
                                  key={entity}
                                  size="xs"
                                  style={{ backgroundColor: NODE_COLORS.Entity, color: "white" }}
                                >
                                  {entity}
                                </Badge>
                              ))}
                            </HStack>
                          )}
                        </Box>
                      ))}
                      {!segLoading && segments.length === 0 && (
                        <Text px={1} pb={1} fontSize="xs" color="gray.400">
                          No transcript sections were returned.
                        </Text>
                      )}
                    </VStack>
                  </Box>
                )}
              </Box>

              <Box
                w={{ base: "100%", xl: "264px" }}
                flexShrink={0}
                position={{ xl: "sticky" }}
                top={{ xl: 0 }}
              >
                <StudyNotes videoId={selected.id} />
              </Box>
            </Flex>
          </>
        ) : (
          <Flex h="100%" align="center" justify="center" color="gray.400">
            <Text fontSize="sm">Choose a talk to begin.</Text>
          </Flex>
        )}
      </Box>
    </Flex>
  );
}
