"use client";

import { useEffect, useCallback, useMemo, useState, useRef } from "react";
import {
  Box,
  Button,
  Text,
  Flex,
  Badge,
  VStack,
  HStack,
  Heading,
  IconButton,
  Spinner,
} from "@chakra-ui/react";
import { X, RotateCcw } from "lucide-react";
import {
  CONCEPT_STATUS_COLORS,
  NODE_COLORS,
  NODE_SIZES,
  SCHEMA_NODE_SIZE,
  SCHEMA_REL_COLOR,
  API_BASE,
} from "@/lib/config";
import type { GraphData } from "@/lib/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

interface GraphRelationship {
  id: string;
  type: string;
  startNodeId: string;
  endNodeId: string;
  properties: Record<string, unknown>;
}

interface InternalGraphData {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

interface NvlNode {
  id: string;
  caption?: string;
  title?: string;
  color?: string;
  size?: number;
  captionSize?: number;
  selected?: boolean;
}

interface NvlRelationship {
  id: string;
  from: string;
  to: string;
  caption?: string;
  color?: string;
  width?: number;
  selected?: boolean;
}

// GET /api/knowledge-map — the viewer's knowledge state as a concept graph
interface KnowledgeMapNode {
  id: string;
  name: string;
  kind: string;
  status: string;
  type: "concept" | "goal";
  matched_concept?: string | null;
  source?: string | null;
  advances_goals?: string[];
  videos?: string[];
  segment_count?: number;
  covered_by?: number;
}

interface KnowledgeMapEdge {
  source: string;
  target: string;
  weight?: number;
  kind?: string;
}

interface KnowledgeStats {
  known: number;
  goal: number;
  novel: number;
  terms_total: number;
  goals: number;
  known_pct: number;
}

type GraphView = "knowledge" | "schema" | "data";

interface SelectedElement {
  type: "node" | "relationship";
  data: GraphNode | GraphRelationship;
}

interface ContextGraphViewProps {
  externalGraphData?: GraphData | null;
  onAskAbout?: (entityName: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers — convert backend serialized data to internal format
// ---------------------------------------------------------------------------

function extractNodesAndRels(results: Record<string, unknown>[]): InternalGraphData {
  const nodeMap = new Map<string, GraphNode>();
  const relMap = new Map<string, GraphRelationship>();

  function processValue(value: unknown, depth = 0) {
    if (!value || typeof value !== "object" || depth > 10) return;

    if (Array.isArray(value)) {
      for (const item of value) processValue(item, depth + 1);
      return;
    }

    const v = value as Record<string, unknown>;

    // Node: has labels array
    if (Array.isArray(v.labels) && v.elementId) {
      const id = String(v.elementId);
      if (!nodeMap.has(id)) {
        const { elementId, labels, ...props } = v;
        nodeMap.set(id, {
          id,
          labels: labels as string[],
          properties: props,
        });
      }
      return;
    }

    // Relationship: has type and startNodeElementId
    if (v.type && v.startNodeElementId) {
      const id = String(v.elementId || v.id || Math.random());
      if (!relMap.has(id)) {
        const { elementId, type, startNodeElementId, endNodeElementId, ...props } = v;
        relMap.set(id, {
          id,
          type: String(type),
          startNodeId: String(startNodeElementId),
          endNodeId: String(endNodeElementId),
          properties: props,
        });
      }
      return;
    }

    // Path: has nodes + relationships arrays
    if (Array.isArray(v.nodes) && Array.isArray(v.relationships)) {
      for (const n of v.nodes) processValue(n, depth + 1);
      for (const r of v.relationships) processValue(r, depth + 1);
      return;
    }

    // Recurse into nested objects
    for (const val of Object.values(v)) {
      processValue(val, depth + 1);
    }
  }

  for (const record of results) {
    for (const value of Object.values(record)) {
      processValue(value);
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    relationships: Array.from(relMap.values()),
  };
}

function getNodeColor(labels: string[], properties: Record<string, unknown>): string {
  if (labels.includes("Concept") && typeof properties.status === "string") {
    const statusColor = CONCEPT_STATUS_COLORS[properties.status];
    if (statusColor) return statusColor;
  }
  for (const label of labels) {
    if (NODE_COLORS[label]) return NODE_COLORS[label];
  }
  return "#6366f1";
}

function getNodeSize(labels: string[]): number {
  for (const label of labels) {
    if (NODE_SIZES[label]) return NODE_SIZES[label];
  }
  return 20;
}

// ---------------------------------------------------------------------------
// Knowledge map — concept graph coloured by what the viewer already knows
// ---------------------------------------------------------------------------

// CONCEPT_STATUS_COLORS covers known/goal; the map also returns novel concepts
// and the goal hubs the clusters hang off.
const KNOWLEDGE_COLORS: Record<string, string> = {
  ...CONCEPT_STATUS_COLORS,
  novel: "#f97316", // orange — nothing in the knowledge base covers it yet
  goal_hub: "#1d4ed8", // deep blue — a stated learning goal
};

/** Which legend badge a node belongs to. Keys match the badges exactly, so a
 *  toggle can never refer to a group the legend does not show. */
function nodeGroup(node: GraphNode, view: string): string {
  if (view === "knowledge") return (node.properties.status as string) || "other";
  if (node.labels.includes("Concept") && typeof node.properties.status === "string")
    return `Concept:${node.properties.status}`;
  return node.labels[0] || "other";
}

const KNOWLEDGE_STATUS_LABELS: Record<string, string> = {
  known: "Known",
  goal: "Advances a goal",
  novel: "New to you",
  goal_hub: "Learning goal",
};

// Vault sources come back as absolute paths; the note name is what the viewer recognises
function noteName(source: string): string {
  return source.split("/").pop() || source;
}

// Video titles are derived from filenames, so they arrive as
// `L8_Principal_s_Agentic_Engineering_Workflow`. Nobody should have to read that.
function displayTitle(title: string): string {
  return title.replace(/_s_/g, "'s ").replaceAll("_", " ");
}

function isKnowledgeNode(properties: Record<string, unknown>): boolean {
  return typeof properties.status === "string" && properties.status in KNOWLEDGE_COLORS;
}

function knowledgeNodeColor(properties: Record<string, unknown>): string {
  return KNOWLEDGE_COLORS[properties.status as string] || "#6366f1";
}

// Goals are hubs: bigger, scaled by how much of the corpus advances them.
// Concepts scale by how many segments teach them.
function knowledgeNodeSize(properties: Record<string, unknown>): number {
  if (properties.type === "goal") {
    const covered = Number(properties.covered_by) || 0;
    return 36 + 2.4 * Math.sqrt(covered);
  }
  const segments = Number(properties.segment_count) || 1;
  return 14 + 4 * Math.sqrt(segments);
}

// Heavier co-occurrence (more segments taught both) renders thicker and darker,
// so subject areas read as clusters instead of one flat hairball.
function edgeWeightColor(weight: number, isAdvances: boolean): string {
  if (isAdvances) return "#93c5fd";
  if (weight >= 4) return "#475569";
  if (weight >= 2) return "#94a3b8";
  return "#dbe1e8";
}

function knowledgeMapToGraph(map: {
  nodes: KnowledgeMapNode[];
  edges: KnowledgeMapEdge[];
}): InternalGraphData {
  const nodes: GraphNode[] = map.nodes.map((n) => {
    const { id, type, ...rest } = n;
    return {
      id,
      labels: [type === "goal" ? "Goal" : "Concept"],
      properties: { ...rest, type },
    };
  });

  const relationships: GraphRelationship[] = map.edges.map((e, i) => ({
    id: `km-${i}-${e.source}-${e.target}`,
    type: e.kind === "advances" ? "ADVANCES" : "CO_OCCURS",
    startNodeId: e.source,
    endNodeId: e.target,
    properties: { weight: e.weight ?? 1 },
  }));

  return { nodes, relationships };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ContextGraphView({ externalGraphData, onAskAbout }: ContextGraphViewProps) {
  const [view, setView] = useState<GraphView>("knowledge");
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedRelId, setSelectedRelId] = useState<string | null>(null);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [graphData, setGraphData] = useState<InternalGraphData | null>(null);
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());

  // Load the viewer's knowledge map on mount
  useEffect(() => {
    loadKnowledgeMap();
  }, []);

  // When external graph data arrives from chat, switch to data view
  useEffect(() => {
    if (externalGraphData?.results?.length) {
      const data = extractNodesAndRels(externalGraphData.results);
      if (data.nodes.length > 0) {
        setGraphData(data);
        setView("data");
        setExpandedNodeIds(new Set());
        setSelectedElement(null);
        setSelectedNodeId(null);
        setSelectedRelId(null);
      }
    }
  }, [externalGraphData]);

  async function loadKnowledgeMap() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/knowledge-map`, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      if (Array.isArray(data.nodes) && Array.isArray(data.edges)) {
        setGraphData(knowledgeMapToGraph(data));
        setStats(data.stats ?? null);
      }
      setView("knowledge");
      setExpandedNodeIds(new Set());
      setSelectedElement(null);
      setSelectedNodeId(null);
      setSelectedRelId(null);
    } catch {
      setError("Unable to load your knowledge map. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }

  async function loadSchema() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/schema/visualization`, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      if (data.nodes && data.relationships) {
        // db.schema.visualization() returns serialized Node/Relationship objects
        const schemaData = extractNodesAndRels([data]);
        setGraphData(schemaData);
      } else if (data.labels) {
        // Fallback: basic schema — create synthetic nodes for labels
        const nodes: GraphNode[] = data.labels.map((label: string, i: number) => ({
          id: `schema-${label}`,
          labels: [label],
          properties: { name: label, isSchemaNode: true },
        }));
        setGraphData({ nodes, relationships: [] });
      }
      setView("schema");
      setExpandedNodeIds(new Set());
      setSelectedElement(null);
    } catch {
      setError("Unable to load schema. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }

  // Double-click: expand node (schema → load label instances, data → expand neighbors)
  const handleNodeDoubleClick = useCallback(
    async (node: NvlNode) => {
      if (!graphData || isExpanding) return;

      if (view === "schema") {
        // Schema node: load instances of this label
        const label = node.caption?.replace(/\s*\(\d+\)$/, "");
        if (!label) return;
        setLoading(true);
        try {
          const res = await fetch(`${API_BASE}/cypher`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: `MATCH (n:\`${label}\`)-[r]-(m) RETURN n, r, m LIMIT 50`,
            }),
            signal: AbortSignal.timeout(10000),
          });
          const data = await res.json();
          const parsed = extractNodesAndRels(data.results || []);
          if (parsed.nodes.length > 0) {
            setGraphData(parsed);
            setView("data");
            setExpandedNodeIds(new Set());
          }
        } catch (err) {
          console.error("Error loading label data:", err);
        } finally {
          setLoading(false);
        }
        return;
      }

      // Data node: expand neighbors
      if (expandedNodeIds.has(node.id)) return;
      setIsExpanding(true);

      try {
        const res = await fetch(`${API_BASE}/expand`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ element_id: node.id }),
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        const expanded = extractNodesAndRels([data]);

        if (expanded.nodes.length === 0) return;

        // Merge, deduplicating
        const existingNodeIds = new Set(graphData.nodes.map((n) => n.id));
        const existingRelIds = new Set(graphData.relationships.map((r) => r.id));
        const newNodes = expanded.nodes.filter((n) => !existingNodeIds.has(n.id));
        const newRels = expanded.relationships.filter((r) => !existingRelIds.has(r.id));

        setGraphData({
          nodes: [...graphData.nodes, ...newNodes],
          relationships: [...graphData.relationships, ...newRels],
        });
        setExpandedNodeIds((prev) => {
          const next = new Set(prev);
          next.add(node.id);
          return next;
        });
      } catch (err) {
        console.error("Error expanding node:", err);
      } finally {
        setIsExpanding(false);
      }
    },
    [graphData, view, isExpanding, expandedNodeIds],
  );

  // Click: select node and show properties
  const handleNodeClick = useCallback(
    (node: NvlNode) => {
      if (!graphData) return;
      const original = graphData.nodes.find((n) => n.id === node.id);
      if (original) {
        setSelectedElement({ type: "node", data: original });
        setSelectedNodeId(node.id);
        setSelectedRelId(null);
      }
    },
    [graphData],
  );

  // Click relationship
  const handleRelationshipClick = useCallback(
    (rel: NvlRelationship) => {
      if (!graphData) return;
      const original = graphData.relationships.find((r) => r.id === rel.id);
      if (original) {
        setSelectedElement({ type: "relationship", data: original });
        setSelectedRelId(rel.id);
        setSelectedNodeId(null);
      }
    },
    [graphData],
  );

  // Click canvas: deselect
  const handleCanvasClick = useCallback(() => {
    setSelectedElement(null);
    setSelectedNodeId(null);
    setSelectedRelId(null);
  }, []);

  // Transform to NVL format
  const nvlData = useMemo(() => {
    if (!graphData) return { nodes: [], relationships: [] };

    // Filtering is what makes a dense graph readable: "show me only what I don't
    // know yet" is the question this project exists to answer, and on a 100-node
    // view it cannot be answered by looking. Legend badges are the control.
    const visible = graphData.nodes.filter((n) => !hiddenGroups.has(nodeGroup(n, view)));
    const visibleIds = new Set(visible.map((n) => n.id));

    const nodes: NvlNode[] = visible.map((node) => {
      const isSelected = selectedNodeId === node.id;
      const isExpanded = expandedNodeIds.has(node.id);
      const isSchema = view === "schema";
      const isKnowledge = isKnowledgeNode(node.properties);

      const caption =
        (node.properties.name as string) ||
        (node.properties.title as string) ||
        node.labels[0] ||
        node.id.slice(0, 8);

      // Build tooltip: for knowledge nodes surface where it comes from and
      // where it is taught, otherwise fall back to the raw properties
      const tooltip = isKnowledge
        ? [
            caption,
            KNOWLEDGE_STATUS_LABELS[node.properties.status as string] || "",
            typeof node.properties.source === "string"
              ? `From your notes: ${noteName(node.properties.source)}`
              : "",
            (node.properties.advances_goals as string[] | undefined)?.length
              ? `Goals: ${(node.properties.advances_goals as string[]).join(", ")}`
              : "",
            (node.properties.videos as string[] | undefined)?.length
              ? `Taught in: ${(node.properties.videos as string[]).map(displayTitle).join(", ")}`
              : "",
            node.properties.covered_by !== undefined
              ? `${node.properties.covered_by} concepts advance this goal`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        : [
            caption,
            `Labels: ${node.labels.join(", ")}`,
            ...Object.entries(node.properties)
              .filter(([k]) => k !== "name" && k !== "title")
              .slice(0, 5)
              .map(([k, v]) => `${k}: ${v}`),
          ].join("\n");

      const baseSize = isKnowledge
        ? knowledgeNodeSize(node.properties)
        : getNodeSize(node.labels);

      return {
        id: node.id,
        caption,
        title: tooltip,
        // A node's colour is its knowledge state and nothing else. Selection
        // used to repaint it red and expansion green — red is not in the
        // palette and reads as an error, and green already means "you know
        // this". Both states are carried by the ring and the size instead.
        color: isKnowledge
          ? knowledgeNodeColor(node.properties)
          : getNodeColor(node.labels, node.properties),
        size: isSchema
          ? SCHEMA_NODE_SIZE
          : isSelected
            ? baseSize * 1.3
            : isExpanded
              ? baseSize * 1.15
              : baseSize,
        selected: isSelected,
      };
    });

    // An edge to a hidden node would render as a line into empty space.
    const relationships: NvlRelationship[] = graphData.relationships
      .filter((rel) => visibleIds.has(rel.startNodeId) && visibleIds.has(rel.endNodeId))
      .map((rel) => {
      const isSelected = selectedRelId === rel.id;
      const weight = Number(rel.properties.weight) || 0;
      const isAdvances = rel.type === "ADVANCES";

      // Knowledge edges carry a co-occurrence weight: heavier = thicker + darker
      if (weight > 0) {
        return {
          id: rel.id,
          from: rel.startNodeId,
          to: rel.endNodeId,
          caption: weight >= 3 && !isAdvances ? `${weight}` : undefined,
          color: isSelected ? "#E53E3E" : edgeWeightColor(weight, isAdvances),
          width: isAdvances ? 1.5 : Math.min(1 + weight * 1.2, 7),
          selected: isSelected,
        };
      }

      return {
        id: rel.id,
        from: rel.startNodeId,
        to: rel.endNodeId,
        caption: rel.type,
        color: isSelected ? "#E53E3E" : view === "schema" ? SCHEMA_REL_COLOR : "#A0AEC0",
        selected: isSelected,
      };
    });

    return { nodes, relationships };
  }, [graphData, selectedNodeId, selectedRelId, expandedNodeIds, view, hiddenGroups]);

  // Group keys differ between views, so a filter left on in one view would
  // silently hide nodes in the other with no badge to turn it back on.
  useEffect(() => {
    setHiddenGroups(new Set());
  }, [view]);

  // Only offer a filter for something actually on screen. NODE_COLORS carries the
  // starter's label palette, most of which this ontology never uses, so the legend
  // showed toggles that could not change anything — six of ten were inert.
  const presentGroups = useMemo(() => {
    if (!graphData) return new Set<string>();
    return new Set(graphData.nodes.map((n) => nodeGroup(n, view)));
  }, [graphData, view]);

  const toggleGroup = useCallback((group: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const selectedNodeProps =
    selectedElement?.type === "node" ? (selectedElement.data as GraphNode).properties : null;

  // Where a concept came from is the provenance claim this whole project rests on, so
  // it has to survive a click. Knowledge-map nodes put the note path in `source`; raw
  // Concept nodes from Neo4j keep the enum there ('vault' | 'goals' | 'video') and the
  // real path in `note_path`. Rendering `source` blindly showed 109 concepts sourced
  // to the literal word "vault".
  const provenance = useMemo(() => {
    if (!selectedNodeProps) return null;
    const source = typeof selectedNodeProps.source === "string" ? selectedNodeProps.source : "";
    const notePath =
      typeof selectedNodeProps.note_path === "string" ? selectedNodeProps.note_path : "";
    const learnedFrom =
      typeof selectedNodeProps.learned_from === "string" ? selectedNodeProps.learned_from : "";

    if (source === "goals") return { label: "A goal you stated", value: "", raw: "" };
    if (source === "video")
      return {
        label: "Captured from a video",
        value: learnedFrom || "a video you watched",
        raw: learnedFrom,
      };
    const path = notePath || (source && source !== "vault" ? source : "");
    if (!path) return null;
    return { label: "From your notes", value: noteName(path), raw: path };
  }, [selectedNodeProps]);

  // Empty / error states
  if (error) {
    return (
      <Flex h="100%" align="center" justify="center">
        <Text color="gray.500">{error}</Text>
      </Flex>
    );
  }

  return (
    <Box h="100%" position="relative">
      {/* Header bar */}
      <Flex
        position="absolute"
        top={0}
        left={0}
        right={0}
        zIndex={10}
        px={4}
        py={2}
        bg="white"
        borderBottom="1px solid"
        borderColor="gray.200"
        justify="space-between"
        align="center"
      >
        <Box>
          {/* Sentence case, like the rest of the app. */}
          <Heading size="sm">
            {view === "knowledge"
              ? "Your knowledge map"
              : view === "schema"
                ? "Database schema"
                : "Knowledge graph"}
          </Heading>
          <Text fontSize="xs" color="gray.500">
            {view === "knowledge"
              ? stats
                ? `${stats.terms_total} concepts · ${stats.goals} learning goals · you already know ${stats.known_pct}% of the corpus — double-click a concept to see where it is taught`
                : "Concepts the corpus teaches, coloured by what you already know"
              : view === "schema"
                ? "Double-click a label to explore it"
                : "Video entity relationships"}
          </Text>
        </Box>
        <HStack gap={1}>
          {view !== "knowledge" && (
            <IconButton
              aria-label="Back to your knowledge map"
              size="xs"
              variant="ghost"
              onClick={loadKnowledgeMap}
            >
              <RotateCcw size={14} />
            </IconButton>
          )}
          {view !== "schema" && (
            <Button size="xs" variant="ghost" color="gray.500" onClick={loadSchema}>
              Schema
            </Button>
          )}
        </HStack>
      </Flex>

      {/* Legend — horizontal strip across the top; wraps to more rows as needed */}
      <Flex
        position="absolute"
        top="52px"
        left={2}
        maxW="calc(100% - 16px)"
        w="fit-content"
        zIndex={10}
        bg="whiteAlpha.900"
        borderRadius="md"
        px={2}
        py={1.5}
        gap={2}
        rowGap={1.5}
        flexWrap="wrap"
        alignItems="center"
        boxShadow="sm"
        borderWidth="1px"
        borderColor="gray.200"
        css={{ backdropFilter: "blur(2px)" }}
      >
        {view === "knowledge" ? (
          <>
            {(["known", "goal", "novel", "goal_hub"] as const).map((status) => (
              <Badge
                key={`km-${status}`}
                size="sm"
                px={2}
                py={0.5}
                whiteSpace="nowrap"
                cursor="pointer"
                title={hiddenGroups.has(status) ? "Show these" : "Hide these"}
                opacity={hiddenGroups.has(status) ? 0.35 : 1}
                textDecoration={hiddenGroups.has(status) ? "line-through" : undefined}
                onClick={() => toggleGroup(status)}
                style={{ backgroundColor: KNOWLEDGE_COLORS[status], color: "white" }}
              >
                {KNOWLEDGE_STATUS_LABELS[status]}
                {stats
                  ? ` ${status === "goal_hub" ? stats.goals : stats[status as "known" | "goal" | "novel"]}`
                  : ""}
              </Badge>
            ))}
            {/* The corpus-known stat used to sit here as a fifth pill. Every
                other pill in this row is a filter you can click; that one was
                not, so it taught people the row was decoration. It now lives
                in the subtitle with the other counts. */}
          </>
        ) : (
          <>
            {Object.entries(NODE_COLORS)
              .filter(([label]) => label !== "Concept" && presentGroups.has(label))
              .map(([label, color]) => (
                <Badge
                  key={label}
                  size="sm"
                  px={2}
                  py={0.5}
                  whiteSpace="nowrap"
                  cursor="pointer"
                  title={hiddenGroups.has(label) ? "Show these" : "Hide these"}
                  opacity={hiddenGroups.has(label) ? 0.35 : 1}
                  textDecoration={hiddenGroups.has(label) ? "line-through" : undefined}
                  onClick={() => toggleGroup(label)}
                  style={{ backgroundColor: color, color: "white" }}
                >
                  {label}
                </Badge>
              ))}
            {Object.entries(CONCEPT_STATUS_COLORS)
              .filter(([status]) => presentGroups.has(`Concept:${status}`))
              .map(([status, color]) => (
              <Badge
                key={`concept-${status}`}
                size="sm"
                px={2}
                py={0.5}
                whiteSpace="nowrap"
                cursor="pointer"
                title={hiddenGroups.has(`Concept:${status}`) ? "Show these" : "Hide these"}
                opacity={hiddenGroups.has(`Concept:${status}`) ? 0.35 : 1}
                textDecoration={
                  hiddenGroups.has(`Concept:${status}`) ? "line-through" : undefined
                }
                onClick={() => toggleGroup(`Concept:${status}`)}
                style={{ backgroundColor: color, color: "white" }}
              >
                {status === "known" ? "Known concept" : "Learning goal"}
              </Badge>
            ))}
          </>
        )}
      </Flex>

      {/* Properties panel — fixed to the viewport's lower-right (overlays the
          usually-blank bottom of the right-hand Videos panel), clear of the graph */}
      {selectedElement && (
        <Box
          position="fixed"
          bottom={4}
          right={4}
          zIndex={1000}
          bg="white"
          borderRadius="md"
          p={3}
          w="300px"
          maxW="calc(100vw - 32px)"
          maxH="70vh"
          overflow="auto"
          boxShadow="2xl"
          borderWidth="1px"
          borderColor="gray.200"
        >
          <Flex justify="space-between" align="start" gap={2} mb={3}>
            {/* Name the thing the viewer clicked. "Node Properties" is what the
                database calls this panel, not what a person came here for. */}
            <Heading size="sm" lineHeight="1.3">
              {selectedElement.type === "node"
                ? String(
                    (selectedElement.data as GraphNode).properties.name ??
                      (selectedElement.data as GraphNode).properties.title ??
                      "Selected node",
                  )
                : "Connection"}
            </Heading>
            <IconButton
              aria-label="Close"
              size="xs"
              variant="ghost"
              onClick={handleCanvasClick}
            >
              <X size={14} />
            </IconButton>
          </Flex>

          {selectedElement.type === "node" && (
            <VStack align="stretch" gap={3}>
              {/* Neo4j labels are the storage class, not information — and on a
                  knowledge node the status badge below already says what it is.
                  Only show them where they are the node's only identity. */}
              {!(selectedNodeProps && isKnowledgeNode(selectedNodeProps)) && (
                <HStack flexWrap="wrap" gap={1}>
                  {(selectedElement.data as GraphNode).labels.map((label) => (
                    <Badge key={label} size="sm" colorPalette="gray" variant="subtle">
                      {label}
                    </Badge>
                  ))}
                </HStack>
              )}
              {onAskAbout && typeof (selectedElement.data as GraphNode).properties.name === "string" && (
                <Button
                  size="xs"
                  colorPalette="blue"
                  variant="outline"
                  onClick={() => {
                    const name = (selectedElement.data as GraphNode).properties.name as string;
                    onAskAbout(name);
                  }}
                >
                  Ask about {((selectedElement.data as GraphNode).properties.name as string).slice(0, 30)}
                </Button>
              )}
              {selectedNodeProps && isKnowledgeNode(selectedNodeProps) ? (
                <VStack align="stretch" gap={2} fontSize="xs">
                  <Badge
                    alignSelf="flex-start"
                    size="sm"
                    style={{
                      backgroundColor: knowledgeNodeColor(selectedNodeProps),
                      color: "white",
                    }}
                  >
                    {/* status:'goal' means two different things depending on the node.
                        On a video term it means "advances a goal"; on a Concept the node
                        IS the goal, and calling it "Advances a goal" is nonsense. */}
                    {selectedNodeProps.status === "goal" &&
                    (selectedElement?.data as GraphNode)?.labels?.includes("Concept")
                      ? "Learning goal"
                      : KNOWLEDGE_STATUS_LABELS[selectedNodeProps.status as string]}
                  </Badge>

                  {provenance && (
                    <Box bg="gray.50" p={2} borderRadius="sm">
                      <Text fontWeight="medium" color="gray.600">
                        {provenance.label}
                      </Text>
                      {provenance.value && (
                        <Text color="gray.800" wordBreak="break-word" title={provenance.raw}>
                          {provenance.value}
                        </Text>
                      )}
                      {typeof selectedNodeProps.matched_concept === "string" &&
                        selectedNodeProps.matched_concept && (
                          <Text mt={1} color="gray.500">
                            That note is what marks this concept known.
                          </Text>
                        )}
                    </Box>
                  )}

                  {(selectedNodeProps.advances_goals as string[] | undefined)?.length ? (
                    <Box bg="gray.50" p={2} borderRadius="sm">
                      <Text fontWeight="medium" color="gray.600" mb={1}>
                        Advances
                      </Text>
                      <HStack flexWrap="wrap" gap={1}>
                        {(selectedNodeProps.advances_goals as string[]).map((goal) => (
                          // Solid fill on a text-length label read as a stuck
                          // text selection. Subtle keeps blue meaning "goal".
                          <Badge key={goal} size="sm" colorPalette="blue" variant="subtle">
                            {goal}
                          </Badge>
                        ))}
                      </HStack>
                    </Box>
                  ) : null}

                  {(selectedNodeProps.videos as string[] | undefined)?.length ? (
                    <Box bg="gray.50" p={2} borderRadius="sm">
                      <Text fontWeight="medium" color="gray.600" mb={1}>
                        Taught in {String(selectedNodeProps.segment_count ?? "")} segment
                        {Number(selectedNodeProps.segment_count) === 1 ? "" : "s"}
                      </Text>
                      <VStack align="stretch" gap={1}>
                        {(selectedNodeProps.videos as string[]).map((title) => (
                          <Text key={title} color="gray.800">
                            {displayTitle(title)}
                          </Text>
                        ))}
                      </VStack>
                    </Box>
                  ) : null}

                  {selectedNodeProps.type === "goal" && (
                    <Box bg="gray.50" p={2} borderRadius="sm">
                      <Text color="gray.800">
                        {String(selectedNodeProps.covered_by ?? 0)} concepts in the corpus advance
                        this goal
                      </Text>
                    </Box>
                  )}
                </VStack>
              ) : (
              <VStack align="stretch" gap={1}>
                {Object.entries((selectedElement.data as GraphNode).properties)
                  .filter(([key]) => !key.startsWith("_") && key !== "isSchemaNode" && key !== "embedding")
                  .map(([key, value]) => (
                    <Box key={key} bg="gray.50" p={1} borderRadius="sm" fontSize="xs">
                      <Text fontWeight="medium" color="gray.600">
                        {key.replace(/_/g, " ")}
                      </Text>
                      <Text color="gray.800" wordBreak="break-word" whiteSpace="pre-wrap">
                        {typeof value === "object"
                          ? JSON.stringify(value, null, 2)
                          : String(value ?? "—")}
                      </Text>
                    </Box>
                  ))}
              </VStack>
              )}
            </VStack>
          )}

          {selectedElement.type === "relationship" && (
            <VStack align="stretch" gap={2}>
              <HStack>
                <Text fontSize="xs" fontWeight="bold" color="gray.500">
                  Type:
                </Text>
                <Badge size="sm" colorPalette="gray">
                  {(selectedElement.data as GraphRelationship).type}
                </Badge>
              </HStack>
              {Object.keys((selectedElement.data as GraphRelationship).properties).length > 0 && (
                <VStack align="stretch" gap={1}>
                  {Object.entries((selectedElement.data as GraphRelationship).properties).map(
                    ([key, value]) => (
                      <Box key={key} bg="gray.50" p={1} borderRadius="sm" fontSize="xs">
                        <Text fontWeight="medium" color="gray.600">
                          {key.replace(/_/g, " ")}
                        </Text>
                        <Text color="gray.800" wordBreak="break-word">
                          {typeof value === "object"
                            ? JSON.stringify(value, null, 2)
                            : String(value ?? "—")}
                        </Text>
                      </Box>
                    ),
                  )}
                </VStack>
              )}
            </VStack>
          )}
        </Box>
      )}

      {/* Instructions */}
      <Box
        position="absolute"
        bottom={2}
        left={2}
        zIndex={10}
        bg="white"
        borderRadius="md"
        px={2}
        py={1}
        boxShadow="sm"
        borderWidth="1px"
        borderColor="gray.200"
        opacity={0.8}
      >
        <Text fontSize="xs" color="gray.500">
          Scroll to zoom | Drag to pan | Click to inspect | Double-click to expand
        </Text>
      </Box>

      {/* Loading overlay */}
      {(loading || isExpanding) && (
        <Flex
          position="absolute"
          top="50%"
          left="50%"
          transform="translate(-50%, -50%)"
          zIndex={20}
          bg="white"
          borderRadius="md"
          p={3}
          boxShadow="md"
          borderWidth="1px"
          borderColor="gray.200"
          align="center"
          gap={2}
        >
          <Spinner size="sm" />
          <Text fontSize="sm">{isExpanding ? "Expanding node..." : "Loading..."}</Text>
        </Flex>
      )}

      {/* Graph */}
      <Box h="100%" w="100%" pt="48px">
        {nvlData.nodes.length > 0 ? (
          <NvlGraph
            nodes={nvlData.nodes}
            relationships={nvlData.relationships}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onRelationshipClick={handleRelationshipClick}
            onCanvasClick={handleCanvasClick}
          />
        ) : graphData && graphData.nodes.length > 0 ? (
          /* The graph loaded fine — the filters are just hiding all of it. Showing
             "your graph will appear here" there reads as data loss. */
          <Flex h="100%" align="center" justify="center" direction="column" gap={3} p={8}>
            <Text color="gray.500" fontWeight="medium">
              Every category is hidden
            </Text>
            <Text color="gray.500" fontSize="sm" textAlign="center" maxW="320px">
              {graphData.nodes.length} nodes are loaded — the legend filters are hiding
              them all.
            </Text>
            <Button size="sm" variant="outline" onClick={() => setHiddenGroups(new Set())}>
              Show everything
            </Button>
          </Flex>
        ) : (
          <Flex h="100%" align="center" justify="center" direction="column" gap={4} p={8}>
            <Box color="gray.400" fontSize="4xl">🔗</Box>
            <Text color="gray.400" fontWeight="medium" fontSize="lg">
              Your knowledge graph will appear here
            </Text>
            <Text color="gray.500" fontSize="sm" textAlign="center" maxW="300px">
              Ask a question in the chat to query entities, or double-click a concept to see the segments that teach it.
            </Text>
          </Flex>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// NvlGraph — handles dynamic NVL import (avoids SSR issues)
// ---------------------------------------------------------------------------

function NvlGraph({
  nodes,
  relationships,
  onNodeClick,
  onNodeDoubleClick,
  onRelationshipClick,
  onCanvasClick,
}: {
  nodes: NvlNode[];
  relationships: NvlRelationship[];
  onNodeClick: (node: NvlNode) => void;
  onNodeDoubleClick: (node: NvlNode) => void;
  onRelationshipClick: (rel: NvlRelationship) => void;
  onCanvasClick: () => void;
}) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const [NvlComponent, setNvlComponent] = useState<React.ComponentType<any> | null>(null);
  const [isReady, setIsReady] = useState(false);
  const nvlRef = useRef<any>(null);

  useEffect(() => {
    import("@neo4j-nvl/react").then((mod) => {
      setNvlComponent(() => mod.InteractiveNvlWrapper);
    });
  }, []);

  useEffect(() => {
    if (NvlComponent && nodes.length > 0) {
      const timer = setTimeout(() => setIsReady(true), 100);
      return () => clearTimeout(timer);
    }
  }, [NvlComponent, nodes.length]);

  if (!NvlComponent) {
    return (
      <Flex h="100%" align="center" justify="center">
        <Text color="gray.500">Loading graph visualization...</Text>
      </Flex>
    );
  }

  return (
    <NvlComponent
      ref={nvlRef}
      nodes={nodes}
      rels={relationships}
      nvlOptions={{
        layout: "d3Force",
        // the knowledge map is ~100 nodes — start zoomed out enough to see the clusters
        initialZoom: nodes.length > 40 ? 0.45 : 1,
        minZoom: 0.1,
        maxZoom: 5,
        relationshipThickness: 2,
        disableTelemetry: true,
      }}
      mouseEventCallbacks={{
        onNodeClick: (node: NvlNode) => onNodeClick(node),
        onNodeDoubleClick: (node: NvlNode) => onNodeDoubleClick(node),
        onRelationshipClick: (rel: NvlRelationship) => onRelationshipClick(rel),
        onCanvasClick: () => onCanvasClick(),
        onZoom: isReady,
        onPan: isReady,
        onDrag: isReady,
      }}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
