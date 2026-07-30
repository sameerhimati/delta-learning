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
  Textarea,
  VStack,
} from "@chakra-ui/react";
import {
  ArrowRight,
  Check,
  Clock3,
  RefreshCw,
  SkipForward,
  Sparkles,
  X,
} from "lucide-react";
import { API_BASE, CONCEPT_STATUS_COLORS } from "@/lib/config";

interface QuizVideo {
  id: string;
  title: string;
  duration_sec: number;
}

export interface QuizQuestion {
  concept: string;
  question: string;
  /** Grading key. NEVER rendered before the viewer has answered. */
  answer_key: string;
  status: "novel" | "goal";
  segment_id: string | null;
  start_sec: number | null;
}

interface QuizResponse {
  video: QuizVideo;
  questions: QuizQuestion[];
}

export interface GradeVerdict {
  concept: string;
  verdict: string;
}

export interface GradeResponse {
  video: QuizVideo;
  passed: GradeVerdict[];
  failed: GradeVerdict[];
  captured: string[];
  still_recommended: string[];
  summary: string;
}

export interface QuizFlowProps {
  /** Video title fragment or id — same identifier the delta endpoint takes. */
  videoId: string;
  /** Fired when the viewer accepts the graded result; the parent refetches the delta. */
  onComplete?: (result: GradeResponse) => void;
  /** Fired when the viewer backs out before grading. */
  onClose?: () => void;
  /** How many concepts to quiz on. */
  count?: number;
}

// Only proved concepts are written to the knowledge state, so a pass has to read
// as "known" and a miss has to keep reading as "novel" — the colours are semantic.
const PASS_COLOR = CONCEPT_STATUS_COLORS.known; // green
const GOAL_COLOR = CONCEPT_STATUS_COLORS.goal; // blue
const FAIL_COLOR = "#f97316"; // orange — matches the "new to you" pills in Your Cut

/** Grading is a reasoning call; this is the estimate the progress bar eases toward. */
const GRADE_ESTIMATE_SEC = 22;

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

export function QuizFlow({ videoId, onComplete, onClose, count = 3 }: QuizFlowProps) {
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [visited, setVisited] = useState<Record<string, true>>({});

  const [grading, setGrading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [result, setResult] = useState<GradeResponse | null>(null);
  const [accepted, setAccepted] = useState(false);

  const loadQuiz = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setQuestions(null);
    setIndex(0);
    setAnswers({});
    setDraft("");
    setVisited({});
    setResult(null);
    setGradeError(null);
    setAccepted(false);

    try {
      const response = await fetch(
        `${API_BASE}/quiz/${encodeURIComponent(videoId)}?count=${count}`,
        { signal: AbortSignal.timeout(60000) },
      );
      if (!response.ok) {
        throw new Error(`Quiz request failed (${response.status})`);
      }
      const payload = (await response.json()) as QuizResponse;
      setQuestions(payload.questions || []);
    } catch (requestError) {
      setQuestions(null);
      setLoadError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to build a quiz for this video.",
      );
    } finally {
      setLoading(false);
    }
  }, [count, videoId]);

  useEffect(() => {
    void loadQuiz();
  }, [loadQuiz]);

  // Elapsed counter while the reasoning model grades.
  useEffect(() => {
    if (!grading) {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [grading]);

  const current = questions && questions.length > 0 ? questions[index] : null;
  const isLast = !!questions && index >= questions.length - 1;

  const answeredCount = useMemo(
    () => Object.values(answers).filter((value) => value.trim().length > 0).length,
    [answers],
  );

  const commitDraft = useCallback(
    (value: string) => {
      if (!current) return;
      setAnswers((prev) => ({ ...prev, [current.concept]: value }));
      setVisited((prev) => ({ ...prev, [current.concept]: true }));
    },
    [current],
  );

  const goTo = useCallback(
    (nextIndex: number) => {
      if (!questions) return;
      const clamped = Math.max(0, Math.min(questions.length - 1, nextIndex));
      setIndex(clamped);
      setDraft(answers[questions[clamped].concept] ?? "");
    },
    [answers, questions],
  );

  function advance(value: string) {
    if (!questions || !current) return;
    commitDraft(value);
    if (isLast) return;
    const nextIndex = index + 1;
    setIndex(nextIndex);
    setDraft(answers[questions[nextIndex].concept] ?? "");
  }

  const submit = useCallback(
    async (finalAnswers: Record<string, string>) => {
      if (!questions || questions.length === 0) return;
      setGrading(true);
      setGradeError(null);
      setResult(null);

      try {
        const response = await fetch(`${API_BASE}/quiz/grade`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            video: videoId,
            // Blank is a legitimate "I don't know" — every question is sent.
            answers: questions.map((question) => ({
              concept: question.concept,
              answer: finalAnswers[question.concept] ?? "",
            })),
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) {
          throw new Error(`Grading failed (${response.status})`);
        }
        setResult((await response.json()) as GradeResponse);
      } catch (requestError) {
        setGradeError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to grade your answers.",
        );
      } finally {
        setGrading(false);
      }
    },
    [questions, videoId],
  );

  function handleSubmit() {
    if (!current) return;
    const finalAnswers = { ...answers, [current.concept]: draft };
    setAnswers(finalAnswers);
    setVisited((prev) => ({ ...prev, [current.concept]: true }));
    void submit(finalAnswers);
  }

  // ---------------------------------------------------------------- loading
  if (loading) {
    return (
      <Shell>
        <Flex minH="200px" align="center" justify="center" direction="column" gap={3}>
          <Spinner size="sm" color="purple.500" />
          <Text fontSize="xs" color="gray.500">
            Writing questions on what is still new to you…
          </Text>
        </Flex>
      </Shell>
    );
  }

  // ------------------------------------------------------------------ error
  if (loadError) {
    return (
      <Shell>
        <Box p={4} borderWidth="1px" borderColor="red.200" borderRadius="lg" bg="red.50">
          <Heading size="sm" color="red.700">
            Could not start the quiz
          </Heading>
          <Text mt={1} fontSize="xs" color="red.600">
            {loadError}
          </Text>
          <HStack mt={3} gap={2}>
            <Button size="xs" variant="outline" colorPalette="red" onClick={() => void loadQuiz()}>
              <RefreshCw size={12} />
              Try again
            </Button>
            {onClose && (
              <Button size="xs" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            )}
          </HStack>
        </Box>
      </Shell>
    );
  }

  // ------------------------------------------------------------- no questions
  if (!questions || questions.length === 0) {
    return (
      <Shell>
        <Box p={6} textAlign="center">
          <Text fontSize="sm" fontWeight="semibold" color="gray.800">
            Nothing left to prove in this video.
          </Text>
          <Text mt={1} fontSize="xs" color="gray.500">
            There are no unproven concepts here, so there is nothing to quiz you on.
          </Text>
          {onClose && (
            <Button mt={4} size="sm" variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </Box>
      </Shell>
    );
  }

  // ----------------------------------------------------------------- grading
  if (grading) {
    const stages = [
      "Sending your answers…",
      ...questions.map((question) => `Checking your answer on ${question.concept}…`),
      "Writing verdicts…",
    ];
    const stageIndex = Math.min(stages.length - 1, Math.floor(elapsedSeconds / 3));
    const percent = Math.min(92, Math.round((elapsedSeconds / GRADE_ESTIMATE_SEC) * 100));

    return (
      <Shell>
        <VStack align="stretch" gap={4} py={2}>
          <HStack gap={2}>
            <Spinner size="xs" color="purple.500" />
            <Text fontSize="sm" fontWeight="semibold" color="gray.800">
              Grading against the answer key
            </Text>
            <Text fontSize="xs" color="gray.400">
              {elapsedSeconds}s
            </Text>
          </HStack>

          <Box h="6px" overflow="hidden" borderRadius="full" bg="gray.200">
            <Box
              h="100%"
              w={`${Math.max(4, percent)}%`}
              bg="#7c74ff"
              borderRadius="full"
              transition="width 0.9s linear"
            />
          </Box>

          <Text fontSize="xs" color="gray.600">
            {stages[stageIndex]}
          </Text>
          <Text fontSize="xs" color="gray.400">
            A reasoning model reads each answer on its own — this usually takes 10–30 seconds.
          </Text>
        </VStack>
      </Shell>
    );
  }

  // ------------------------------------------------------------ grade failed
  if (gradeError) {
    return (
      <Shell>
        <Box p={4} borderWidth="1px" borderColor="orange.200" borderRadius="lg" bg="orange.50">
          <HStack align="start" gap={2}>
            <Clock3 size={14} color="#c2410c" />
            <Box>
              <Text fontSize="sm" fontWeight="semibold" color="orange.800">
                Grading did not finish
              </Text>
              <Text mt={1} fontSize="xs" color="orange.700">
                {gradeError} Nothing was recorded — your answers are still here.
              </Text>
            </Box>
          </HStack>
          <HStack mt={3} gap={2}>
            <Button
              size="xs"
              colorPalette="orange"
              onClick={() => void submit(answers)}
            >
              <RefreshCw size={12} />
              Grade again
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setGradeError(null)}>
              Back to my answers
            </Button>
          </HStack>
        </Box>
      </Shell>
    );
  }

  // ----------------------------------------------------------------- results
  if (result) {
    const keyFor = (concept: string) =>
      questions.find((question) => question.concept === concept)?.answer_key;

    return (
      <Shell>
        <VStack align="stretch" gap={4}>
          <Box>
            <Text fontSize="xs" fontWeight="semibold" color="purple.600">
              Graded
            </Text>
            <Heading mt={1} size="md" letterSpacing="-0.02em">
              {result.summary}
            </Heading>
            <Text mt={1.5} fontSize="xs" color="gray.500">
              Only what you demonstrated was added to your knowledge. Everything else stays
              in your cut list.
            </Text>
          </Box>

          {result.passed.length > 0 && (
            <VStack align="stretch" gap={2}>
              <HStack gap={2}>
                <Check size={14} color={PASS_COLOR} />
                <Text fontSize="xs" fontWeight="bold" color="green.700">
                  Proved · added to your knowledge ({result.passed.length})
                </Text>
              </HStack>
              {result.passed.map((item) => (
                <Box
                  key={item.concept}
                  p={3}
                  borderWidth="1px"
                  borderLeftWidth="3px"
                  borderColor="green.200"
                  borderLeftColor={PASS_COLOR}
                  borderRadius="11px"
                  bg="green.50"
                >
                  <HStack justify="space-between" align="start" gap={2}>
                    <Text fontSize="sm" fontWeight="semibold" color="green.900">
                      {item.concept}
                    </Text>
                    <Badge colorPalette="green" variant="solid" size="sm">
                      known
                    </Badge>
                  </HStack>
                  <Text mt={1} fontSize="xs" color="green.800" lineHeight="1.55">
                    {item.verdict}
                  </Text>
                </Box>
              ))}
            </VStack>
          )}

          {result.failed.length > 0 && (
            <VStack align="stretch" gap={2}>
              <HStack gap={2}>
                <X size={14} color={FAIL_COLOR} />
                <Text fontSize="xs" fontWeight="bold" color="orange.700">
                  Not demonstrated · still new to you ({result.failed.length})
                </Text>
              </HStack>
              {result.failed.map((item) => {
                const answerKey = keyFor(item.concept);
                return (
                  <Box
                    key={item.concept}
                    p={3}
                    borderWidth="1px"
                    borderLeftWidth="3px"
                    borderColor="#f2d5b5"
                    borderLeftColor={FAIL_COLOR}
                    borderRadius="11px"
                    bg="#fff8f0"
                  >
                    <HStack justify="space-between" align="start" gap={2}>
                      <Text fontSize="sm" fontWeight="semibold" color="orange.900">
                        {item.concept}
                      </Text>
                      <Badge colorPalette="orange" variant="solid" size="sm">
                        still new
                      </Badge>
                    </HStack>
                    <Text mt={1} fontSize="xs" color="orange.800" lineHeight="1.55">
                      {item.verdict}
                    </Text>
                    {answerKey && (
                      <Text mt={2} fontSize="xs" color="orange.700" lineHeight="1.55">
                        <Text as="span" fontWeight="semibold">
                          What we were looking for:{" "}
                        </Text>
                        {answerKey}
                      </Text>
                    )}
                  </Box>
                );
              })}
            </VStack>
          )}

          <Box
            p={3}
            borderWidth="1px"
            borderColor="#e2e3e6"
            borderRadius="11px"
            bg={result.still_recommended.length > 0 ? "#fafafa" : "green.50"}
          >
            {result.still_recommended.length > 0 ? (
              <>
                <Text fontSize="xs" fontWeight="bold" color="gray.700">
                  Staying in your cut list
                </Text>
                <Text mt={1} fontSize="xs" color="gray.600" lineHeight="1.55">
                  These keep their timecodes — nothing was recorded for them.
                </Text>
                <HStack mt={2} gap={1.5} flexWrap="wrap">
                  {result.still_recommended.map((concept) => (
                    <Badge key={concept} colorPalette="orange" variant="subtle">
                      {concept}
                    </Badge>
                  ))}
                </HStack>
              </>
            ) : (
              <Text fontSize="xs" fontWeight="semibold" color="green.800">
                You proved every concept in this quiz — none of it stays in your cut list.
              </Text>
            )}
          </Box>

          <Button
            colorPalette="purple"
            size="md"
            h="44px"
            borderRadius="11px"
            boxShadow="0 6px 16px rgba(98,91,246,0.20)"
            disabled={accepted}
            onClick={() => {
              setAccepted(true);
              onComplete?.(result);
            }}
          >
            <Sparkles size={15} />
            {accepted ? "Cut list updated" : "See my updated cut"}
          </Button>
        </VStack>
      </Shell>
    );
  }

  // --------------------------------------------------------------- answering
  const question = current!;
  const isGoal = question.status === "goal";

  return (
    <Shell>
      <VStack align="stretch" gap={4}>
        <HStack justify="space-between" align="start">
          <Box>
            <Text fontSize="xs" fontWeight="semibold" color="purple.600">
              Prove it
            </Text>
            <Text mt={0.5} fontSize="xs" color="gray.500">
              Question {index + 1} of {questions.length} · {answeredCount} answered
            </Text>
          </Box>
          {onClose && (
            <Button size="xs" variant="ghost" color="gray.500" onClick={onClose}>
              Cancel
            </Button>
          )}
        </HStack>

        <HStack gap={1.5} flexWrap="wrap">
          {questions.map((item, itemIndex) => {
            const answered = (answers[item.concept] ?? "").trim().length > 0;
            const seen = !!visited[item.concept];
            const isCurrent = itemIndex === index;
            return (
              <Box
                key={item.concept}
                as="button"
                onClick={() => {
                  commitDraft(draft);
                  goTo(itemIndex);
                }}
                px={2}
                py={1}
                borderWidth="1px"
                borderColor={isCurrent ? "#aaa5f7" : "#e2e3e6"}
                borderRadius="full"
                bg={answered ? "green.50" : seen ? "#fff8f0" : "white"}
                fontSize="10px"
                fontWeight="semibold"
                color={answered ? "green.700" : seen ? "orange.700" : "gray.500"}
                maxW="180px"
                truncate
              >
                {itemIndex + 1}. {item.concept}
              </Box>
            );
          })}
        </HStack>

        <Box
          p={4}
          borderWidth="1px"
          borderColor="#e2e3e6"
          borderLeftWidth="3px"
          borderLeftColor={isGoal ? GOAL_COLOR : FAIL_COLOR}
          borderRadius="13px"
          bg="white"
        >
          <HStack gap={2} mb={2} flexWrap="wrap">
            <Text fontSize="xs" fontWeight="bold" color="gray.800">
              {question.concept}
            </Text>
            <Badge colorPalette={isGoal ? "blue" : "orange"} variant="subtle" size="sm">
              {isGoal ? "your goal" : "new to you"}
            </Badge>
            {question.start_sec !== null && (
              <Text fontSize="10px" color="gray.400">
                covered from {formatTime(question.start_sec)}
              </Text>
            )}
          </HStack>
          <Text fontSize="sm" color="gray.800" lineHeight="1.6">
            {question.question}
          </Text>
        </Box>

        <Box
          borderWidth="1px"
          borderColor="#dedfe3"
          rounded="12px"
          bg="#fafafa"
          _focusWithin={{ borderColor: "#aaa5f7", boxShadow: "0 0 0 3px rgba(98,91,246,0.10)" }}
          transition="border-color 0.2s, box-shadow 0.2s"
        >
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (isLast) handleSubmit();
                else advance(draft);
              }
            }}
            placeholder="Answer in your own words. Blank counts as “I don't know.”"
            border="none"
            _focus={{ boxShadow: "none" }}
            resize="none"
            rows={4}
            fontSize="sm"
            px={3}
            py={2}
            bg="transparent"
          />
        </Box>

        <HStack justify="space-between" gap={2}>
          <Button
            size="sm"
            variant="ghost"
            color="gray.500"
            onClick={() => {
              setDraft("");
              advance("");
            }}
          >
            <SkipForward size={13} />
            Skip — I don&apos;t know
          </Button>

          {isLast ? (
            <Button
              size="sm"
              colorPalette="purple"
              borderRadius="10px"
              onClick={handleSubmit}
            >
              <Sparkles size={13} />
              Grade my answers
            </Button>
          ) : (
            <Button
              size="sm"
              colorPalette="purple"
              borderRadius="10px"
              onClick={() => advance(draft)}
            >
              Next
              <ArrowRight size={13} />
            </Button>
          )}
        </HStack>

        <Text fontSize="10px" color="gray.400" textAlign="right">
          Skipped and blank answers count as unproven — those concepts stay in your cut list.
        </Text>
      </VStack>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Box
      p={{ base: 3, md: 4 }}
      borderWidth="1px"
      borderColor="#e2e3e6"
      borderRadius="16px"
      bg="white"
      boxShadow="0 1px 2px rgba(17,24,39,0.025)"
    >
      {children}
    </Box>
  );
}
