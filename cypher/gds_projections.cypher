// GDS graph algorithms for Delta Learning
// -----------------------------------------------------------------------------
// GDS IS INSTALLED on this deployment (verified: `RETURN gds.version()` -> 2.13.2),
// so these are real Graph Data Science calls, not a Cypher emulation.
//
// The starter shipped this file against the generic agent-memory ontology
// (Person/Organization/Memory/ToolCall...). None of those labels exist here.
// Repointed at the ontology this project actually built:
//
//   (:Video)-[:HAS_SEGMENT]->(:Segment)-[:ABOUT|MENTIONS]->(:Topic|:Entity)
//   (:Topic|:Entity)-[:SAME_AS]->(:Concept {status:'known'})   // viewer knows it
//   (:Topic|:Entity)-[:ADVANCES]->(:Concept {status:'goal'})   // viewer wants it
//
// The structure worth running algorithms over is NOT the stored relationships —
// it's the *co-occurrence* graph they imply: two terms are connected when the same
// Segment teaches both, weighted by how many segments do so. That relationship is
// not stored in Neo4j, so every projection below is a GDS **Cypher projection**
// (gds.graph.project as an aggregating function), built in memory and dropped after.
//
// Every query in this file was executed against the live demo database and returns
// rows. Nothing here writes to the database: all algorithms use .stream(), so the
// Video/Segment/Topic/Entity/Concept data is never mutated.
//
// "Learnable" term = same definition as backend/app/delta.py: any Topic, plus
// Entities of type concept|event|product (a person or a brand isn't something you
// learn from a talk).

// =============================================================================
// 1. TERM CO-OCCURRENCE -> COMMUNITIES ("the knowledge map")
// =============================================================================
// Project every learnable term; edge weight = number of segments teaching both.

CALL gds.graph.drop('delta_terms', false) YIELD graphName RETURN graphName;

MATCH (s:Segment)-[:ABOUT|MENTIONS]->(a)
MATCH (s)-[:ABOUT|MENTIONS]->(b)
WHERE ((a:Topic) OR (a:Entity AND a.type IN ['concept','event','product']))
  AND ((b:Topic) OR (b:Entity AND b.type IN ['concept','event','product']))
  AND elementId(a) < elementId(b)
WITH a, b, count(DISTINCT s) AS w
WITH gds.graph.project('delta_terms', a, b,
  { relationshipProperties: { weight: w } },
  { undirectedRelationshipTypes: ['*'] }) AS g
RETURN g.graphName AS graph, g.nodeCount AS nodes, g.relationshipCount AS rels;
// -> delta_terms, 209 nodes, 1282 rels

// Louvain over co-occurrence: the corpus self-organizes into subject areas without
// anyone labelling them. Each community also reports how much of it the viewer
// already knows — a per-topic "you're 80% through this cluster" read.
CALL gds.louvain.stream('delta_terms', { relationshipWeightProperty: 'weight' })
YIELD nodeId, communityId
WITH communityId, gds.util.asNode(nodeId) AS x
OPTIONAL MATCH (x)-[:SAME_AS]->(k:Concept {status: 'known'})
WITH communityId, x, count(k) > 0 AS is_known
WITH communityId,
     count(*) AS size,
     sum(CASE WHEN is_known THEN 1 ELSE 0 END) AS known,
     collect(DISTINCT x.name)[0..6] AS sample
WHERE size >= 5
RETURN communityId, size, known, size - known AS unknown, sample
ORDER BY size DESC;
// -> e.g. community 100 (28 terms): Game Theory, Prisoner's Dilemma, Nash
//    Equilibrium, Cooperative Game...  community 79 (30): PostgreSQL, GIN Index...

// =============================================================================
// 2. THE LEARNING FRONTIER ("what should I learn first?")  <- the demo query
// =============================================================================
// Same co-occurrence graph, but every term the viewer already knows is removed
// BEFORE projecting. What's left is literally the frontier of their ignorance, and
// PageRank over it ranks terms by how much of the rest of the unknown they unlock.
// This is the query behind the `learning_frontier` agent tool in backend/app/agent.py.

CALL gds.graph.drop('delta_frontier', false) YIELD graphName RETURN graphName;

MATCH (s:Segment)-[:ABOUT|MENTIONS]->(a)
MATCH (s)-[:ABOUT|MENTIONS]->(b)
WHERE ((a:Topic) OR (a:Entity AND a.type IN ['concept','event','product']))
  AND ((b:Topic) OR (b:Entity AND b.type IN ['concept','event','product']))
  AND elementId(a) < elementId(b)
  AND NOT (a)-[:SAME_AS]->(:Concept {status: 'known'})
  AND NOT (b)-[:SAME_AS]->(:Concept {status: 'known'})
WITH a, b, count(DISTINCT s) AS w
WITH gds.graph.project('delta_frontier', a, b,
  { relationshipProperties: { weight: w } },
  { undirectedRelationshipTypes: ['*'] }) AS g
RETURN g.graphName AS graph, g.nodeCount AS nodes, g.relationshipCount AS rels;
// -> delta_frontier, ~163 nodes, ~864 rels (the known terms drop out; this count
//    SHRINKS every time capture_learning runs — that is the whole thesis, measured)

// Rank the frontier, and say where to go watch each one.
CALL gds.pageRank.stream('delta_frontier', { relationshipWeightProperty: 'weight' })
YIELD nodeId, score
WITH gds.util.asNode(nodeId) AS x, score
MATCH (v:Video)-[:HAS_SEGMENT]->(s:Segment)-[:ABOUT|MENTIONS]->(x)
OPTIONAL MATCH (x)-[:ADVANCES]->(g:Concept {status: 'goal'})
WITH x.name AS term,
     max(score) AS pagerank,
     collect(DISTINCT g.name) AS goals,
     count(DISTINCT v) AS video_count,
     count(DISTINCT s) AS segment_count,
     collect(DISTINCT {video: v.title, start_sec: s.start_sec, end_sec: s.end_sec})[0..2]
       AS where_taught
RETURN term,
       round(pagerank, 3) AS pagerank,
       CASE WHEN size(goals) > 0 THEN 'goal' ELSE 'novel' END AS status,
       goals[0] AS serves_goal,
       video_count, segment_count, where_taught
ORDER BY pagerank DESC
LIMIT 10;
// -> PostgreSQL 4.558 (goal: database internals), First Mate 3.094 (novel),
//    No Mistakes 3.085, Git Worktree 2.255, Codex COI 2.187 (goal: context
//    engineering for agents), Claude Code 1.798, Token Efficiency 1.736 ...

CALL gds.graph.drop('delta_frontier', false) YIELD graphName RETURN graphName;
CALL gds.graph.drop('delta_terms', false)    YIELD graphName RETURN graphName;

// =============================================================================
// 3. BRIDGE TERMS ACROSS VIDEOS ("the same thing, taught twice")
// =============================================================================
// No projection needed — this one is pure Cypher, and it is the payoff of MERGE-ing
// Topics/Entities by normalized name at ingest: one node, many videos. It's also the
// cheapest proof of the thesis — a term you learned in video A is skippable in video B.
MATCH (v:Video)-[:HAS_SEGMENT]->(:Segment)-[:ABOUT|MENTIONS]->(x)
WHERE (x:Topic) OR (x:Entity AND x.type IN ['concept','event','product'])
WITH x, collect(DISTINCT v.title) AS videos
WHERE size(videos) >= 2
OPTIONAL MATCH (x)-[:SAME_AS]->(k:Concept {status: 'known'})
RETURN x.name AS term,
       size(videos) AS n_videos,
       videos,
       CASE WHEN count(k) > 0 THEN 'known' ELSE 'unknown' END AS status
ORDER BY n_videos DESC, term;
// -> Cooperation / Cooperative Game / Game Theory / Non-Cooperative Game /
//    Prisoner's Dilemma — each in both Game Theory talks, all already 'known'.
