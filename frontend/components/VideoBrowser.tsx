"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ArrowLeft, Clock3, Film, Library } from "lucide-react";
import { API_BASE } from "@/lib/config";
import { DELTA_FIXTURE, YourCutPanel } from "@/components/YourCutPanel";
import { StudyNotes } from "@/components/StudyNotes";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import type { TranscriptRange } from "@/components/TranscriptPanel";

interface Video {
  id: string;
  title: string;
  url: string;
  duration_sec: number | null;
  summary: string;
  segment_count: number;
}

const FIXTURE_VIDEO: Video = {
  id: DELTA_FIXTURE.video.id,
  title: DELTA_FIXTURE.video.title,
  url: "",
  duration_sec: DELTA_FIXTURE.video.duration_sec,
  summary: "Personalized cut preview using the frozen Delta Learning API contract.",
  segment_count: DELTA_FIXTURE.cuts.length,
};

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
  const [cutRanges, setCutRanges] = useState<TranscriptRange[]>([]);
  const [usingFixture, setUsingFixture] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Stable so YourCutPanel's emit effect does not re-fire every render.
  const handleCutsChange = useCallback((cuts: TranscriptRange[]) => {
    setCutRanges(cuts);
  }, []);

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
      } catch {
        setVideos([FIXTURE_VIDEO]);
        setSelected(FIXTURE_VIDEO);
        setUsingFixture(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function openVideo(video: Video) {
    setCutRanges([]);
    setSelected(video);
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
        borderColor="line"
        bg="#f8f8f9"
        display={{ base: selected ? "none" : "flex", md: "flex" }}
      >
        <Box px={4} pt={4} pb={4} borderBottomWidth="1px" borderColor="line">
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
                    borderColor={isSelected ? "#cbc8fb" : "line"}
                    borderRadius="control"
                    bg="white"
                    boxShadow={isSelected ? "0 1px 2px rgba(17,24,39,0.05)" : "none"}
                    cursor="pointer"
                    transition="border-color 0.15s ease, background 0.15s ease"
                    _hover={{ borderColor: "#b8b4f8" }}
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
                          lineHeight="1.4"
                          color="gray.900"
                          lineClamp={2}
                          title={displayTitle(video.title)}
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
            <Box borderBottomWidth="1px" borderColor="line">
              <Box px={{ base: 4, lg: 6 }} py={6} maxW="1180px" mx="auto">
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
                <HStack gap={2} mb={2} color="gray.500">
                  <Box w={1.5} h={1.5} borderRadius="full" bg="brand.500" />
                  <Text fontSize="xs" fontWeight="semibold" color="brand.600">
                    Now studying
                  </Text>
                  <Text fontSize="xs">·</Text>
                  <Text fontSize="xs">{durationLabel(selected.duration_sec)}</Text>
                </HStack>
                <Heading
                  maxW="900px"
                  fontSize={{ base: "xl", lg: "26px" }}
                  lineHeight="1.2"
                  letterSpacing="-0.03em"
                >
                  {displayTitle(selected.title)}
                </Heading>
                {selected.summary && (
                  <Text maxW="720px" mt={2} fontSize="sm" color="gray.500" lineHeight="1.65">
                    {selected.summary}
                  </Text>
                )}
                {selected.url && (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video
                    ref={videoRef}
                    src={selected.url}
                    controls
                    // Capped so the delta — not the player — owns the first screen.
                    style={{
                      width: "100%",
                      maxWidth: 640,
                      marginTop: 24,
                      borderRadius: 14,
                      background: "#000",
                    }}
                  />
                )}
              </Box>
            </Box>

            <Flex
              align="flex-start"
              direction={{ base: "column", xl: "row" }}
              gap={6}
              px={{ base: 4, lg: 6 }}
              py={6}
              maxW="1180px"
              mx="auto"
            >
              <VStack flex={1} minW={0} w="100%" align="stretch" gap={6}>
                <YourCutPanel
                  videoId={selected.id}
                  useFixture={usingFixture && selected.id === FIXTURE_VIDEO.id}
                  onSeek={seekTo}
                  onCutsChange={handleCutsChange}
                />

                {!(usingFixture && selected.id === FIXTURE_VIDEO.id) && (
                  <TranscriptPanel
                    videoId={selected.id}
                    highlights={cutRanges}
                    onSeek={selected.url ? seekTo : undefined}
                    // Reading surface: let it flow with the page instead of
                    // trapping the transcript in a second scrollbar.
                    maxH="none"
                  />
                )}
              </VStack>

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
          <Flex h="100%" align="center" justify="center" direction="column" gap={3} px={6}>
            <Flex
              align="center"
              justify="center"
              w={10}
              h={10}
              borderRadius="control"
              bg="#f1f0fe"
              color="brand.500"
            >
              <Library size={18} />
            </Flex>
            <Text fontSize="md" fontWeight="semibold" color="gray.700">
              Pick a talk to see your cut
            </Text>
            <Text fontSize="sm" color="gray.500" textAlign="center" maxW="320px">
              Delta compares each talk against what you already know and keeps only the
              parts that are new.
            </Text>
          </Flex>
        )}
      </Box>
    </Flex>
  );
}
