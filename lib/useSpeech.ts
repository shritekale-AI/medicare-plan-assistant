"use client";

/**
 * Browser speech input/output via the Web Speech API.
 *
 * WHY THE BROWSER API RATHER THAN A HOSTED SPEECH SERVICE:
 * no API key, no added latency, no cost, and it degrades gracefully. Voice matters
 * for the primary persona (68, mild hearing loss, uneasy with dense forms) but it must
 * never be the only way through — every voice affordance here has a text equivalent,
 * and the app is fully usable with speech switched off or unsupported.
 *
 * Support is good in Chrome and Edge; Safari and Firefox are inconsistent. `supported`
 * reflects that honestly rather than pretending.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export function useSpeech() {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [supported, setSupported] = useState({ input: false, output: false });
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSupported({
      input: Boolean(Ctor),
      output: typeof window !== "undefined" && "speechSynthesis" in window,
    });
  }, []);

  const listen = useCallback((onResult: (text: string) => void) => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) onResult(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  /** Strip markdown so the synthesiser doesn't read asterisks and hashes aloud. */
  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();

    const plain = text
      .replace(/\*\*/g, "")
      .replace(/[*_#`]/g, "")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();

    const utterance = new SpeechSynthesisUtterance(plain);
    utterance.rate = 0.95; // marginally slower — this audience skews older
    utterance.pitch = 1;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }, []);

  const stopSpeaking = useCallback(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  return { listening, speaking, supported, listen, stopListening, speak, stopSpeaking };
}
