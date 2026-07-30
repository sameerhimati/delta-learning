"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Button, Heading, HStack, Text, Textarea } from "@chakra-ui/react";
import { Check, NotebookPen, Trash2 } from "lucide-react";

interface StudyNotesProps {
  videoId: string;
}

const NOTES_PREFIX = "delta-study-notes:";

export function StudyNotes({ videoId }: StudyNotesProps) {
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      setNotes(localStorage.getItem(`${NOTES_PREFIX}${videoId}`) || "");
    } catch {
      setNotes("");
    }
    setSaved(false);

    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [videoId]);

  function updateNotes(value: string) {
    setNotes(value);
    try {
      localStorage.setItem(`${NOTES_PREFIX}${videoId}`, value);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 1600);
    } catch {
      setSaved(false);
    }
  }

  return (
    // Notes are a secondary surface next to the cut list. A hairline is enough;
    // the lifted shadow made it compete with the panel it sits beside.
    <Box
      borderWidth="1px"
      borderColor="#e1e2e5"
      borderRadius="14px"
      bg="white"
      overflow="hidden"
    >
      <HStack px={4} py={3} justify="space-between" borderBottomWidth="1px" borderColor="#e8e9eb">
        <HStack gap={2}>
          <NotebookPen size={16} color="#8b8f98" />
          <Box>
            <Heading size="sm">Study notes</Heading>
            <Text mt={1} fontSize="xs" color="gray.500">
              Private to this video
            </Text>
          </Box>
        </HStack>
        {notes && (
          <Button
            aria-label="Clear study notes"
            size="xs"
            variant="ghost"
            color="gray.400"
            onClick={() => updateNotes("")}
          >
            <Trash2 size={13} />
          </Button>
        )}
      </HStack>
      <Box p={3}>
        <Textarea
          value={notes}
          onChange={(event) => updateNotes(event.target.value)}
          placeholder={"Capture the idea in your own words…\n\n• What changed?\n• What will you try?"}
          minH={{ base: "180px", xl: "320px" }}
          resize="vertical"
          borderWidth="1px"
          borderColor="#e8e9eb"
          borderRadius="10px"
          bg="#fafafa"
          px={3}
          py={3}
          fontSize="sm"
          lineHeight="1.7"
          _placeholder={{ color: "gray.400" }}
          _focus={{ borderColor: "#aaa5f7", boxShadow: "0 0 0 3px rgba(98,91,246,0.10)" }}
        />
        <HStack justify="space-between" px={1} pt={2}>
          <Text fontSize="xs" color="gray.500">Autosaved on this device</Text>
          {saved && (
            <HStack gap={1} color="green.600">
              <Check size={12} />
              <Text fontSize="xs" fontWeight="medium">Saved</Text>
            </HStack>
          )}
        </HStack>
      </Box>
    </Box>
  );
}
