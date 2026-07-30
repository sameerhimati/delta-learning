"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  IconButton,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  BookOpen,
  BrainCircuit,
  MessageCircle,
  Network,
  NotebookText,
} from "lucide-react";
import dynamic from "next/dynamic";
import { ChatInterface } from "@/components/ChatInterface";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { VideoBrowser } from "@/components/VideoBrowser";
import { WhatIKnowPanel } from "@/components/WhatIKnowPanel";
import { API_BASE } from "@/lib/config";
import type { GraphData } from "@/lib/config";

function PanelPlaceholder({ message }: { message: string }) {
  return (
    <Flex h="100%" align="center" justify="center" direction="column" gap={4} px={6}>
      <VStack gap={2} w="100%" maxW="180px" animation="delta-pulse 1.6s ease-in-out infinite">
        <Box w="100%" h="6px" borderRadius="full" bg="gray.300" />
        <Box w="70%" h="6px" borderRadius="full" bg="gray.300" alignSelf="flex-start" />
      </VStack>
      <Text fontSize="sm" color="gray.500">
        {message}
      </Text>
    </Flex>
  );
}

const ContextGraphView = dynamic(
  () => import("@/components/ContextGraphView").then((mod) => mod.ContextGraphView),
  {
    ssr: false,
    loading: () => <PanelPlaceholder message="Laying out your knowledge map…" />,
  },
);

type ViewId = "study" | "knowledge" | "chat" | "graph";

const VIEWS = {
  study: {
    label: "Study",
    title: "Study workspace",
    description: "Watch only the parts that add to what you know.",
    icon: BookOpen,
  },
  knowledge: {
    label: "What I know",
    title: "What I know",
    description: "Your vault notes, captures, and goals as the graph sees them.",
    icon: NotebookText,
  },
  chat: {
    label: "Ask Delta",
    title: "Ask Delta",
    description: "Explore a talk, concept, or learning path.",
    icon: MessageCircle,
  },
  graph: {
    label: "Knowledge map",
    title: "Knowledge map",
    description: "See how your concepts, goals, and talks connect.",
    icon: Network,
  },
} satisfies Record<ViewId, {
  label: string;
  title: string;
  description: string;
  icon: typeof BookOpen;
}>;

const VIEW_ORDER = Object.keys(VIEWS) as ViewId[];

function ConnectionStatus({
  status,
}: {
  status: "ok" | "degraded" | "offline";
}) {
  const copy =
    status === "ok" ? "Synced" : status === "degraded" ? "Limited" : "Offline";
  const color =
    status === "ok" ? "green.500" : status === "degraded" ? "orange.500" : "red.500";

  return (
    <HStack
      gap={2}
      px={3}
      py={1.5}
      borderWidth="1px"
      borderColor="line"
      borderRadius="full"
      bg="white"
      title={
        status === "ok"
          ? "Backend connected"
          : status === "degraded"
            ? "Backend connected with limited graph access"
            : "Backend offline"
      }
    >
      <Box w={2} h={2} borderRadius="full" bg={color} />
      <Text fontSize="xs" fontWeight="medium" color="gray.600">
        {copy}
      </Text>
    </HStack>
  );
}

export default function Home() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [activeView, setActiveView] = useState<ViewId>("study");
  const [backendStatus, setBackendStatus] =
    useState<"ok" | "degraded" | "offline">("offline");
  const [askAboutInput, setAskAboutInput] = useState<string | null>(null);
  const [knowledgeToken, setKnowledgeToken] = useState(0);

  const handleGraphUpdate = useCallback((data: GraphData) => {
    setGraphData(data);
  }, []);

  const handleAskAbout = useCallback((entityName: string) => {
    setAskAboutInput(`Tell me about ${entityName}`);
    setActiveView("chat");
  }, []);

  // Captures happen in the study view, so re-read the knowledge state each visit.
  const selectView = useCallback((viewId: ViewId) => {
    setActiveView(viewId);
    if (viewId === "knowledge") setKnowledgeToken((token) => token + 1);
  }, []);

  useEffect(() => {
    async function checkHealth(retries = 3, delay = 1000) {
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const response = await fetch(`${API_BASE.replace("/api", "")}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          const data = await response.json();
          setBackendStatus(data.status === "ok" ? "ok" : "degraded");
          return;
        } catch {
          if (attempt < retries - 1) {
            await new Promise((resolve) => setTimeout(resolve, delay * (attempt + 1)));
          }
        }
      }
      setBackendStatus("offline");
    }

    void checkHealth();
    const interval = setInterval(() => void checkHealth(1), 60000);
    return () => clearInterval(interval);
  }, []);

  const activeMeta = VIEWS[activeView];

  return (
    <Flex h="100dvh" bg="#f5f5f7" color="ink" overflow="hidden">
      <Flex
        as="aside"
        aria-label="Primary navigation"
        display={{ base: "none", md: "flex" }}
        direction="column"
        w="224px"
        flexShrink={0}
        px={4}
        py={6}
        bg="white"
        borderRightWidth="1px"
        borderColor="line"
      >
        <HStack gap={2.5} px={2} mb={8}>
          <Box flexShrink={0} color="brand.500">
            <BrainCircuit size={20} />
          </Box>
          <Box>
            <Heading size="sm" letterSpacing="-0.02em" color="ink">
              Delta
            </Heading>
            <Text fontSize="xs" color="gray.400">
              Learning workspace
            </Text>
          </Box>
        </HStack>

        <VStack align="stretch" gap={1}>
          {VIEW_ORDER.map((viewId) => {
            const view = VIEWS[viewId];
            const Icon = view.icon;
            const isActive = activeView === viewId;
            return (
              <Button
                key={viewId}
                variant="ghost"
                justifyContent="flex-start"
                gap={3}
                h={10}
                px={3}
                borderRadius="control"
                fontSize="sm"
                fontWeight={isActive ? "semibold" : "normal"}
                color={isActive ? "ink" : "gray.500"}
                bg={isActive ? "#f2f2f4" : "transparent"}
                _hover={{ bg: "#f7f7f8", color: "ink" }}
                onClick={() => selectView(viewId)}
              >
                <Icon size={16} color={isActive ? "#625bf6" : "currentColor"} />
                {view.label}
              </Button>
            );
          })}
        </VStack>

        <Text mt="auto" px={2} fontSize="xs" color="gray.400" lineHeight="1.6">
          Your watch list shrinks as your knowledge grows.
        </Text>
      </Flex>

      <Flex direction="column" flex={1} minW={0}>
        <Flex
          as="header"
          minH={16}
          px={{ base: 4, md: 6 }}
          align="center"
          justify="space-between"
          gap={4}
          borderBottomWidth="1px"
          borderColor="line"
          bg="rgba(255,255,255,0.94)"
          backdropFilter="blur(12px)"
        >
          <HStack gap={3} minW={0}>
            <Flex
              display={{ base: "flex", md: "none" }}
              align="center"
              justify="center"
              w={8}
              h={8}
              flexShrink={0}
              borderRadius="control"
              bg="brand.500"
              color="white"
            >
              <BrainCircuit size={18} />
            </Flex>
            <Box minW={0}>
              <Heading size="md" letterSpacing="-0.02em" lineHeight="1.25">
                {activeMeta.title}
              </Heading>
              <Text
                display={{ base: "none", sm: "block" }}
                fontSize="sm"
                color="gray.500"
                lineHeight="1.5"
              >
                {activeMeta.description}
              </Text>
            </Box>
          </HStack>
          <ConnectionStatus status={backendStatus} />
        </Flex>

        <Box
          as="main"
          flex={1}
          minH={0}
          p={{ base: 0, md: 4 }}
          pb={{ base: "72px", md: 4 }}
        >
          <Box
            h="100%"
            overflow="hidden"
            bg="white"
            borderWidth={{ base: 0, md: "1px" }}
            borderColor="line"
            borderRadius={{ base: 0, md: "panel" }}
          >
            <Box h="100%" display={activeView === "study" ? "block" : "none"}>
              <VideoBrowser />
            </Box>
            <Box
              as="section"
              aria-label="What I know"
              h="100%"
              overflowY="auto"
              bg="#f8f8f9"
              display={activeView === "knowledge" ? "block" : "none"}
            >
              <Box px={{ base: 4, lg: 6 }} py={{ base: 4, lg: 6 }} maxW="1180px" mx="auto">
                <ErrorBoundary fallbackMessage="Knowledge state error">
                  <WhatIKnowPanel
                    refreshToken={knowledgeToken}
                    onConceptClick={handleAskAbout}
                  />
                </ErrorBoundary>
              </Box>
            </Box>
            <Box
              as="section"
              aria-label="Chat"
              h="100%"
              display={activeView === "chat" ? "block" : "none"}
            >
              <ChatInterface
                onGraphUpdate={handleGraphUpdate}
                externalInput={askAboutInput}
                onExternalInputConsumed={() => setAskAboutInput(null)}
              />
            </Box>
            <Box
              as="section"
              aria-label="Graph visualization"
              h="100%"
              bg="#f8f8f9"
              display={activeView === "graph" ? "block" : "none"}
            >
              <ErrorBoundary fallbackMessage="Graph visualization error">
                <ContextGraphView externalGraphData={graphData} onAskAbout={handleAskAbout} />
              </ErrorBoundary>
            </Box>
          </Box>
        </Box>
      </Flex>

      <HStack
        as="nav"
        aria-label="Mobile navigation"
        display={{ base: "flex", md: "none" }}
        position="fixed"
        left={0}
        right={0}
        bottom={0}
        zIndex={20}
        justify="space-around"
        px={2}
        py={2}
        borderTopWidth="1px"
        borderColor="line"
        bg="rgba(255,255,255,0.96)"
        backdropFilter="blur(14px)"
      >
        {VIEW_ORDER.map((viewId) => {
          const view = VIEWS[viewId];
          const Icon = view.icon;
          return (
            <IconButton
              key={viewId}
              aria-label={`${view.label} panel`}
              variant="ghost"
              borderRadius="control"
              color={activeView === viewId ? "brand.500" : "gray.400"}
              bg={activeView === viewId ? "brand.50" : "transparent"}
              onClick={() => selectView(viewId)}
            >
              <Icon size={18} />
            </IconButton>
          );
        })}
      </HStack>
    </Flex>
  );
}
