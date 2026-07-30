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
  Input,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  Check,
  FileText,
  Film,
  RefreshCw,
  Search,
  Target,
  X,
} from "lucide-react";
import { API_BASE, CONCEPT_STATUS_COLORS, NODE_COLORS } from "@/lib/config";

interface KnowledgeGoal {
  name: string;
  covered_by: number;
  covered: boolean;
}

interface KnownConcept {
  name: string;
  note?: string | null;
  learned_from?: string | null;
  corpus_hits: number;
}

interface KnowledgeStats {
  goals_total: number;
  goals_covered: number;
  known_from_vault: number;
  known_from_video: number;
  vault_relevant_to_corpus: number;
}

export interface KnowledgeResponse {
  goals: KnowledgeGoal[];
  known: {
    from_vault: KnownConcept[];
    from_video: KnownConcept[];
    matched_in_corpus: KnownConcept[];
  };
  stats: KnowledgeStats;
}

interface WhatIKnowPanelProps {
  /** Change this value (e.g. after a capture) to force a refetch. */
  refreshToken?: string | number;
  onConceptClick?: (concept: string) => void;
}

type Provenance = "vault" | "video";

function displayTitle(title: string): string {
  return title.replace(/_s_/g, "'s ").replaceAll("_", " ");
}

function noteName(note?: string | null): string {
  if (!note) return "untitled note";
  return note.split(/[\\/]/).pop() || note;
}

function ProvenanceRow({
  concept,
  provenance,
  sourceLabel,
  isFirst,
  onClick,
}: {
  concept: KnownConcept;
  provenance: Provenance;
  sourceLabel: string;
  isFirst: boolean;
  onClick?: (concept: string) => void;
}) {
  const isVault = provenance === "vault";
  const clickable = Boolean(onClick);
  return (
    <Box
      as={clickable ? "button" : "div"}
      textAlign="left"
      w="100%"
      px={3}
      py={2.5}
      borderTopWidth={isFirst ? 0 : "1px"}
      borderColor="#eceded"
      cursor={clickable ? "pointer" : "default"}
      transition="background 0.12s ease"
      _hover={clickable ? { bg: "#fafafa" } : undefined}
      onClick={clickable ? () => onClick?.(concept.name) : undefined}
    >
      <HStack align="start" justify="space-between" gap={3}>
        <HStack align="start" gap={2.5} minW={0}>
          <Flex
            align="center"
            justify="center"
            mt={0.5}
            w={5}
            h={5}
            flexShrink={0}
            borderRadius="6px"
            bg={isVault ? "#eefaf1" : "#f4f2ff"}
          >
            {isVault ? (
              <FileText size={11} color={CONCEPT_STATUS_COLORS.known} />
            ) : (
              <Film size={11} color={NODE_COLORS.Video} />
            )}
          </Flex>
          <Box minW={0}>
            <Text fontSize="xs" fontWeight="semibold" color="gray.800" lineHeight="1.4">
              {concept.name}
            </Text>
            <Text
              mt={0.5}
              fontSize="10px"
              color="gray.500"
              overflowWrap="anywhere"
              fontFamily={isVault ? "mono" : undefined}
            >
              {sourceLabel}
            </Text>
          </Box>
        </HStack>
        {concept.corpus_hits > 0 && (
          <Badge
            flexShrink={0}
            colorPalette="green"
            variant="subtle"
            borderRadius="full"
            fontSize="10px"
          >
            {concept.corpus_hits} in corpus
          </Badge>
        )}
      </HStack>
    </Box>
  );
}

export function WhatIKnowPanel({ refreshToken, onConceptClick }: WhatIKnowPanelProps) {
  const [data, setData] = useState<KnowledgeResponse | null>(null);
  const [videoTitles, setVideoTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<Provenance>("vault");
  const [query, setQuery] = useState("");

  const loadKnowledge = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/knowledge`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        throw new Error(`Knowledge request failed (${response.status})`);
      }
      setData((await response.json()) as KnowledgeResponse);
    } catch (requestError) {
      setData(null);
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to load your knowledge state.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKnowledge();
  }, [loadKnowledge, refreshToken]);

  // Video titles are a nicety — a failure here must not break the panel.
  useEffect(() => {
    (async () => {
      try {
        const response = await fetch(`${API_BASE}/videos`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          videos?: { id: string; title: string }[];
        };
        const titles: Record<string, string> = {};
        for (const video of payload.videos || []) {
          titles[video.id] = displayTitle(video.title);
        }
        setVideoTitles(titles);
      } catch {
        setVideoTitles({});
      }
    })();
  }, []);

  const list = useMemo(() => {
    if (!data) return [];
    const source =
      provenance === "vault" ? data.known.from_vault : data.known.from_video;
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? source.filter(
          (concept) =>
            concept.name.toLowerCase().includes(needle) ||
            (concept.note || "").toLowerCase().includes(needle),
        )
      : source;
    // Concepts that actually intersect this corpus are the interesting ones.
    return [...filtered].sort(
      (a, b) => b.corpus_hits - a.corpus_hits || a.name.localeCompare(b.name),
    );
  }, [data, provenance, query]);

  if (loading) {
    return (
      <Flex minH="220px" align="center" justify="center" direction="column" gap={3}>
        <Spinner size="sm" color="purple.500" />
        <Text fontSize="xs" color="gray.500">Reading your knowledge state…</Text>
      </Flex>
    );
  }

  if (error || !data) {
    return (
      <Box p={4} borderWidth="1px" borderColor="red.200" borderRadius="lg" bg="red.50">
        <Heading size="sm" color="red.700">Your knowledge state is unavailable</Heading>
        <Text mt={1} fontSize="xs" color="red.600">
          {error || "The backend returned no knowledge state."}
        </Text>
        <Button
          mt={3}
          size="xs"
          variant="outline"
          colorPalette="red"
          onClick={() => void loadKnowledge()}
        >
          Try again
        </Button>
      </Box>
    );
  }

  const { stats, goals } = data;
  const matched = data.known.matched_in_corpus;
  const vaultTotal = stats.known_from_vault;
  const overlapPercent = vaultTotal
    ? Math.max(1, Math.round((stats.vault_relevant_to_corpus / vaultTotal) * 100))
    : 0;
  const sortedGoals = [...goals].sort(
    (a, b) => Number(b.covered) - Number(a.covered) || b.covered_by - a.covered_by,
  );

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
              What I know
            </Text>
            <Text mt={1} fontSize="xs" color="whiteAlpha.600">
              Your vault and your captures, as the graph sees them
            </Text>
          </Box>
          <Button
            size="xs"
            variant="ghost"
            color="whiteAlpha.700"
            _hover={{ bg: "whiteAlpha.200", color: "white" }}
            onClick={() => void loadKnowledge()}
          >
            <RefreshCw size={12} />
            Refresh
          </Button>
        </HStack>

        <Heading
          fontSize={{ base: "2xl", lg: "32px" }}
          lineHeight="1.05"
          letterSpacing="-0.045em"
          maxW="680px"
        >
          {stats.vault_relevant_to_corpus} of {vaultTotal}{" "}
          <Text as="span" color="whiteAlpha.500" fontWeight="normal">
            vault concepts appear in this corpus
          </Text>
        </Heading>
        <Text mt={3} maxW="680px" fontSize="sm" color="whiteAlpha.700" lineHeight="1.55">
          Everything you have written down barely touches these four talks — about{" "}
          {overlapPercent}% overlap. That is why most videos still say “watch most of it”:
          the delta is real, not a rounding error.
        </Text>

        <Grid
          templateColumns="repeat(3, minmax(0, 1fr))"
          mt={5}
          pt={4}
          borderTopWidth="1px"
          borderColor="whiteAlpha.200"
        >
          {[
            {
              value: `${stats.goals_covered}/${stats.goals_total}`,
              label: "goals with coverage",
              color: "blue.300",
            },
            {
              value: String(stats.known_from_vault),
              label: "concepts from your vault",
              color: "green.300",
            },
            {
              value: String(stats.known_from_video),
              label: "captured from watching",
              color: "purple.300",
            },
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

      <Box
        borderWidth="1px"
        borderColor="#e1e2e5"
        borderRadius="14px"
        bg="white"
        overflow="hidden"
        boxShadow="0 1px 2px rgba(17,24,39,0.035)"
      >
        <HStack
          px={4}
          py={3.5}
          justify="space-between"
          borderBottomWidth="1px"
          borderColor="#e8e9eb"
        >
          <Box>
            <Heading size="sm">Where your notes meet this corpus</Heading>
            <Text mt={0.5} fontSize="10px" color="gray.400">
              The only vault notes these talks can skip for you
            </Text>
          </Box>
          <Badge colorPalette="green" variant="subtle" borderRadius="full">
            {matched.length} of {vaultTotal}
          </Badge>
        </HStack>
        {matched.length === 0 ? (
          <Box px={4} py={5}>
            <Text fontSize="xs" color="gray.500">
              None of your vault notes intersect this corpus yet — every video is new
              ground.
            </Text>
          </Box>
        ) : (
          <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap={0}>
            {matched.map((concept, index) => (
              <Box
                key={`${concept.name}-${concept.note || index}`}
                px={4}
                py={3.5}
                borderTopWidth={{ base: index === 0 ? 0 : "1px", md: 0 }}
                borderLeftWidth={{ base: 0, md: index === 0 ? 0 : "1px" }}
                borderColor="#eceded"
              >
                <Text fontSize="sm" fontWeight="semibold" color="gray.800" lineHeight="1.4">
                  {concept.name}
                </Text>
                <HStack mt={1.5} gap={1.5} align="center">
                  <FileText size={11} color="#9aa0a6" />
                  <Text fontSize="10px" fontFamily="mono" color="gray.500" overflowWrap="anywhere">
                    {noteName(concept.note)}
                  </Text>
                </HStack>
                <Text mt={1.5} fontSize="10px" color="green.700" fontWeight="semibold">
                  {concept.corpus_hits} matching{" "}
                  {concept.corpus_hits === 1 ? "concept" : "concepts"} in the videos
                </Text>
              </Box>
            ))}
          </Grid>
        )}
      </Box>

      <Box
        borderWidth="1px"
        borderColor="#e1e2e5"
        borderRadius="14px"
        bg="white"
        overflow="hidden"
        boxShadow="0 1px 2px rgba(17,24,39,0.035)"
      >
        <HStack
          px={4}
          py={3.5}
          justify="space-between"
          borderBottomWidth="1px"
          borderColor="#e8e9eb"
        >
          <HStack gap={2}>
            <Target size={16} color={CONCEPT_STATUS_COLORS.goal} />
            <Box>
              <Heading size="sm">Learning goals</Heading>
              <Text mt={0.5} fontSize="10px" color="gray.400">
                What you told the graph you want to learn
              </Text>
            </Box>
          </HStack>
          <Badge colorPalette="blue" variant="subtle" borderRadius="full">
            {stats.goals_covered} of {stats.goals_total} covered
          </Badge>
        </HStack>

        {sortedGoals.length === 0 ? (
          <Box px={4} py={5}>
            <Text fontSize="xs" color="gray.500">
              No learning goals are defined yet.
            </Text>
          </Box>
        ) : (
          <VStack align="stretch" gap={0}>
            {sortedGoals.map((goal, index) => (
              <HStack
                key={goal.name}
                px={4}
                py={3}
                gap={3}
                align="center"
                justify="space-between"
                borderTopWidth={index === 0 ? 0 : "1px"}
                borderColor="#eceded"
                bg={goal.covered ? "white" : "#fffaf5"}
              >
                <HStack gap={2.5} minW={0}>
                  <Flex
                    align="center"
                    justify="center"
                    w={5}
                    h={5}
                    flexShrink={0}
                    borderRadius="full"
                    bg={goal.covered ? "#eefaf1" : "#fdeee2"}
                  >
                    {goal.covered ? (
                      <Check size={12} color="#16a34a" />
                    ) : (
                      <X size={12} color="#c2410c" />
                    )}
                  </Flex>
                  <Text fontSize="sm" fontWeight="medium" color="gray.800" lineHeight="1.4">
                    {goal.name}
                  </Text>
                </HStack>
                <Text
                  flexShrink={0}
                  fontSize="10px"
                  fontWeight="semibold"
                  color={goal.covered ? "gray.500" : "orange.700"}
                  textAlign="right"
                >
                  {goal.covered
                    ? `${goal.covered_by} corpus ${goal.covered_by === 1 ? "concept" : "concepts"}`
                    : "nothing in this corpus"}
                </Text>
              </HStack>
            ))}
          </VStack>
        )}
      </Box>

      <Box
        borderWidth="1px"
        borderColor="#e1e2e5"
        borderRadius="14px"
        bg="white"
        overflow="hidden"
        boxShadow="0 1px 2px rgba(17,24,39,0.035)"
      >
        <Box px={4} py={3.5} borderBottomWidth="1px" borderColor="#e8e9eb">
          <HStack justify="space-between" align="start" mb={3}>
            <Box>
              <Heading size="sm">What you know</Heading>
              <Text mt={0.5} fontSize="10px" color="gray.400">
                Split by where the knowledge came from
              </Text>
            </Box>
            <Text fontSize="10px" color="gray.400">
              {list.length} shown
            </Text>
          </HStack>

          <HStack gap={2} mb={2.5} flexWrap="wrap">
            {(
              [
                { key: "vault", label: "From my vault", count: stats.known_from_vault },
                { key: "video", label: "Captured from video", count: stats.known_from_video },
              ] as { key: Provenance; label: string; count: number }[]
            ).map((tab) => (
              <Button
                key={tab.key}
                size="xs"
                borderRadius="full"
                variant={provenance === tab.key ? "solid" : "outline"}
                colorPalette={provenance === tab.key ? "purple" : "gray"}
                onClick={() => setProvenance(tab.key)}
              >
                {tab.label} ({tab.count})
              </Button>
            ))}
          </HStack>

          <HStack
            px={2.5}
            gap={2}
            borderWidth="1px"
            borderColor="#e8e9eb"
            borderRadius="10px"
            bg="#fafafa"
            _focusWithin={{
              borderColor: "#aaa5f7",
              boxShadow: "0 0 0 3px rgba(98,91,246,0.10)",
            }}
          >
            <Search size={13} color="#9aa0a6" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                provenance === "vault" ? "Search your notes…" : "Search what you captured…"
              }
              border="none"
              bg="transparent"
              px={0}
              size="sm"
              fontSize="xs"
              _focus={{ boxShadow: "none" }}
              _placeholder={{ color: "gray.400" }}
            />
            {query && (
              <Button
                aria-label="Clear search"
                size="xs"
                variant="ghost"
                color="gray.400"
                onClick={() => setQuery("")}
              >
                <X size={12} />
              </Button>
            )}
          </HStack>
        </Box>

        <Box maxH="420px" overflowY="auto" overflowX="hidden">
          {list.length === 0 ? (
            <Box px={4} py={6} textAlign="center">
              <Text fontSize="xs" color="gray.500">
                {query
                  ? `Nothing matches “${query}”.`
                  : provenance === "vault"
                    ? "No vault notes have been ingested yet."
                    : "You have not captured anything from a video yet."}
              </Text>
            </Box>
          ) : (
            list.map((concept, index) => (
              <ProvenanceRow
                key={`${concept.name}-${concept.note || concept.learned_from || index}`}
                concept={concept}
                provenance={provenance}
                isFirst={index === 0}
                sourceLabel={
                  provenance === "vault"
                    ? noteName(concept.note)
                    : `learned from ${
                        videoTitles[concept.learned_from || ""] ||
                        concept.learned_from ||
                        "a video you watched"
                      }`
                }
                onClick={onConceptClick}
              />
            ))
          )}
        </Box>
      </Box>
    </VStack>
  );
}

export default WhatIKnowPanel;
