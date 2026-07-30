"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  IconButton,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { BookOpen, BrainCircuit, MessageCircle, Network } from "lucide-react";
import dynamic from "next/dynamic";
import { ChatInterface } from "@/components/ChatInterface";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { VideoBrowser } from "@/components/VideoBrowser";
import { API_BASE } from "@/lib/config";
import type { GraphData } from "@/lib/config";

const ContextGraphView = dynamic(
  () => import("@/components/ContextGraphView").then((mod) => mod.ContextGraphView),
  {
    ssr: false,
    loading: () => (
      <Flex align="center" justify="center" h="100%" color="gray.400">
        <Spinner size="lg" />
      </Flex>
    ),
  },
);

type ViewId = "study" | "chat" | "graph";

const VIEWS = {
  study: {
    label: "Study",
    title: "Study workspace",
    description: "Watch only the parts that add to what you know.",
    icon: BookOpen,
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
    description: "See how your videos, concepts, and goals connect.",
    icon: Network,
  },
} satisfies Record<ViewId, {
  label: string;
  title: string;
  description: string;
  icon: typeof BookOpen;
}>;

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
      borderColor="gray.200"
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
      <Text fontSize="xs" fontWeight="semibold" color="gray.600">
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

  const handleGraphUpdate = useCallback((data: GraphData) => {
    setGraphData(data);
  }, []);

  const handleAskAbout = useCallback((entityName: string) => {
    setAskAboutInput(`Tell me about ${entityName}`);
    setActiveView("chat");
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
    <Flex h="100dvh" bg="#f5f6f8" color="gray.900" overflow="hidden">
      <Flex
        as="aside"
        aria-label="Primary navigation"
        display={{ base: "none", md: "flex" }}
        direction="column"
        w="232px"
        flexShrink={0}
        px={4}
        py={5}
        bg="#111318"
        color="white"
      >
        <HStack gap={3} px={2} mb={8}>
          <Flex
            align="center"
            justify="center"
            w={9}
            h={9}
            borderRadius="xl"
            bg="#625bf6"
            color="white"
          >
            <BrainCircuit size={19} />
          </Flex>
          <Box>
            <Heading size="sm" letterSpacing="-0.02em">Delta</Heading>
            <Text fontSize="xs" color="gray.400">learning workspace</Text>
          </Box>
        </HStack>

        <VStack align="stretch" gap={1}>
          {(Object.entries(VIEWS) as [ViewId, typeof VIEWS[ViewId]][]).map(
            ([viewId, view]) => {
              const Icon = view.icon;
              const isActive = activeView === viewId;
              return (
                <Button
                  key={viewId}
                  variant="ghost"
                  justifyContent="flex-start"
                  h="42px"
                  px={3}
                  color={isActive ? "white" : "gray.400"}
                  bg={isActive ? "whiteAlpha.100" : "transparent"}
                  _hover={{ bg: "whiteAlpha.100", color: "white" }}
                  onClick={() => setActiveView(viewId)}
                >
                  <Icon size={17} />
                  {view.label}
                </Button>
              );
            },
          )}
        </VStack>

        <Box mt="auto" px={2}>
          <Text fontSize="xs" color="gray.500" lineHeight="1.5">
            Your knowledge changes.
            <br />
            Your watch list should too.
          </Text>
        </Box>
      </Flex>

      <Flex direction="column" flex={1} minW={0}>
        <Flex
          as="header"
          minH={{ base: "64px", md: "76px" }}
          px={{ base: 4, md: 6 }}
          align="center"
          justify="space-between"
          borderBottomWidth="1px"
          borderColor="gray.200"
          bg="rgba(255,255,255,0.92)"
          backdropFilter="blur(12px)"
        >
          <HStack gap={3}>
            <Flex
              display={{ base: "flex", md: "none" }}
              align="center"
              justify="center"
              w={9}
              h={9}
              borderRadius="xl"
              bg="#625bf6"
              color="white"
            >
              <BrainCircuit size={18} />
            </Flex>
            <Box>
              <Heading size={{ base: "sm", md: "md" }} letterSpacing="-0.025em">
                {activeMeta.title}
              </Heading>
              <Text
                display={{ base: "none", sm: "block" }}
                fontSize="sm"
                color="gray.500"
              >
                {activeMeta.description}
              </Text>
            </Box>
          </HStack>
          <ConnectionStatus status={backendStatus} />
        </Flex>

        <Box as="main" flex={1} minH={0} p={{ base: 0, md: 4 }} pb={{ base: "68px", md: 4 }}>
          <Box
            h="100%"
            overflow="hidden"
            bg="white"
            borderWidth={{ base: 0, md: "1px" }}
            borderColor="gray.200"
            borderRadius={{ base: 0, md: "2xl" }}
            boxShadow={{ base: "none", md: "0 1px 2px rgba(16,24,40,0.04)" }}
          >
            <Box h="100%" display={activeView === "study" ? "block" : "none"}>
              <VideoBrowser />
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
              bg="gray.50"
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
        left={3}
        right={3}
        bottom={3}
        zIndex={20}
        justify="space-around"
        px={2}
        py={2}
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="2xl"
        bg="rgba(255,255,255,0.96)"
        boxShadow="0 10px 30px rgba(15,23,42,0.14)"
        backdropFilter="blur(14px)"
      >
        {(Object.entries(VIEWS) as [ViewId, typeof VIEWS[ViewId]][]).map(
          ([viewId, view]) => {
            const Icon = view.icon;
            return (
              <IconButton
                key={viewId}
                aria-label={`${view.label} panel`}
                variant={activeView === viewId ? "solid" : "ghost"}
                colorPalette={activeView === viewId ? "purple" : "gray"}
                borderRadius="xl"
                onClick={() => setActiveView(viewId)}
              >
                <Icon size={18} />
              </IconButton>
            );
          },
        )}
      </HStack>
    </Flex>
  );
}
