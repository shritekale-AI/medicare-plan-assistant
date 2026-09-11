"use client";

import { useEffect, useRef, useState } from "react";
import { useSpeech } from "@/lib/useSpeech";
import { TracePanel, type TraceEntry } from "@/components/TracePanel";
import { RichText } from "@/components/RichText";
import { FeedbackControls } from "@/components/FeedbackControls";

/**
 * Text size is user-controlled rather than fixed.
 *
 * The original build hard-coded large type for the 65+ primary persona, which is right
 * for Linda and wrong for everyone reviewing the thing — a compliance reviewer working
 * through a long conversation could see two answers at a time. WCAG 1.4.4 asks that
 * text can be resized, not that it start large, so the accessible answer is a control,
 * not a default. Compact is the default because reviewers are the current users; Large
 * is what a member would pick.
 */
const TEXT_SIZES = {
  compact: { body: "text-sm", pad: "px-3 py-2", label: "A" },
  normal: { body: "text-base", pad: "px-3.5 py-2.5", label: "A" },
  large: { body: "text-lg leading-relaxed", pad: "px-4 py-3", label: "A" },
} as const;
type TextSize = keyof typeof TEXT_SIZES;

type Attachment = { mediaType: string; data: string; name: string; previewUrl: string };

type Identity = {
  memberId: string;
  name: string;
  firstName: string;
  currentPlanId: string | null;
  planEnding: boolean;
  zip: string;
  actingAs: { name: string; relationship: string } | null;
};

type SignInOption = { token: string; label: string; sub: string };

type Message = {
  role: "user" | "assistant";
  content: string;
  trace?: TraceEntry[];
  attachmentName?: string;
};

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/**
 * Two entry points, because the two primary personas want opposite interfaces over
 * identical logic — Linda speaks and wants short conversational answers; Amy reads
 * fast and wants comparisons she can defend to her brother. Same engine underneath.
 */
const STARTERS = [
  {
    id: "linda",
    name: "Linda, 68",
    role: "Member whose plan is ending",
    mode: "Prefers voice",
    prompt:
      "I got a letter saying my plan won't be offered next year. I don't know where to start.",
  },
  {
    id: "amy",
    name: "Amy, 44",
    role: "Daughter, researching for Linda",
    mode: "Prefers text",
    prompt:
      "I'm helping my mother — her plan is being discontinued. Can you show me how her options compare?",
  },
  {
    id: "steve",
    name: "Steve, 65",
    role: "New to Medicare, first time shopping",
    mode: "Needs the basics first",
    prompt:
      "I turned 65 in August and I live in 28270. I'm still working part time with coverage through my job, and I only take one blood pressure pill. Honestly I don't know if I need to do anything at all right now — where do I start?",
  },
];

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  const [showTrace, setShowTrace] = useState(true);
  const [textSize, setTextSize] = useState<TextSize>("compact");
  const size = TEXT_SIZES[textSize];

  const [build, setBuild] = useState<{ commit: string; corpusVersion: string } | null>(null);
  const [attachment, setAttachment] = useState<Attachment | null>(null);

  // Identity is a token, never a profile. The record lives server-side.
  const [identityToken, setIdentityToken] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [options, setOptions] = useState<{ members: SignInOption[]; delegates: SignInOption[] } | null>(null);

  const { listening, speaking, supported, listen, stopListening, speak, stopSpeaking } = useSpeech();
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Surfaces which commit and corpus version are actually running, so "is the live
  // link current?" can be answered by looking rather than assuming.
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setBuild({ commit: d.deployment.commit, corpusVersion: d.corpus.version }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Respect prefers-reduced-motion: smooth auto-scroll can trigger discomfort for
    // users with vestibular disorders. WCAG 2.3.3.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    endRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    if (!signInOpen || options) return;
    fetch("/api/identity")
      .then((r) => r.json())
      .then(setOptions)
      .catch(() => {});
  }, [signInOpen, options]);

  async function signIn(token: string) {
    try {
      const res = await fetch("/api/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setError("Could not sign in to that account.");
        return;
      }
      setIdentity(await res.json());
      setIdentityToken(token);
      setSignInOpen(false);
      setMessages([]);
    } catch {
      setError("Could not reach the server.");
    }
  }

  function signOut() {
    setIdentity(null);
    setIdentityToken(null);
    setMessages([]);
  }

  /** Read a chosen image into base64, so it can be sent inline to the API. */
  function handleFile(file: File) {
    setError(null);
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setError("Please choose a photo — JPEG, PNG, WebP, or GIF.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("That photo is too large. Please use one under 4MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setAttachment({
        mediaType: file.type,
        data: result.split(",")[1],
        name: file.name,
        previewUrl: result,
      });
    };
    reader.onerror = () => setError("Could not read that file. Please try another.");
    reader.readAsDataURL(file);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    const image = attachment;
    if ((!trimmed && !image) || loading) return;

    setError(null);
    setInput("");
    setAttachment(null);

    const userContent = trimmed || "Here's the letter I received — what does it mean?";
    const next: Message[] = [
      ...messages,
      { role: "user", content: userContent, attachmentName: image?.name },
    ];
    setMessages(next);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identityToken,
          messages: next.map((m, i) => ({
            role: m.role,
            content: m.content,
            // Only the message just sent carries the image payload.
            ...(image && i === next.length - 1
              ? { image: { mediaType: image.mediaType, data: image.data } }
              : {}),
          })),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.message ?? "Something went wrong.");
        return;
      }

      setMessages([...next, { role: "assistant", content: data.reply, trace: data.trace ?? [] }]);
      if (voiceMode) speak(data.reply);
    } catch {
      setError("Could not reach the assistant. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleMic() {
    if (listening) {
      stopListening();
      return;
    }
    setVoiceMode(true);
    listen((transcript) => {
      setInput(transcript);
      void send(transcript);
    });
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* Keyboard users shouldn't have to tab through the whole header to reach input.
          Visible on focus only — WCAG 2.4.1 Bypass Blocks. */}
      <a
        href="#message-input"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:text-lg focus:ring-4 focus:ring-emerald-600"
      >
        Skip to message box
      </a>

      {/* CMS rules require an AI assistant to disclose that it is automated.
          This banner is a compliance requirement, not decoration. */}
      <div role="note" className="bg-slate-900 px-4 py-2 text-center text-xs text-slate-100">
        <strong>Prototype — you are talking to an AI assistant, not a person.</strong>{" "}
        Built as an interview exercise. Not affiliated with or endorsed by Humana. Uses public plan
        documents. Not insurance advice — verify anything important with a licensed agent.
      </div>

      <header className="border-b border-slate-200 bg-white px-4 py-4">
        {/* flex-wrap, not a fixed row: the right-hand cluster is five items and its
            min-content width exceeds a 375px viewport, which scrolls the whole page
            sideways on a phone. min-w-0 lets the title block shrink rather than push. */}
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="text-base font-semibold">Medicare Plan Assistant</h1>
            <p className="text-xs text-slate-600">
              21 plans · Mecklenburg County, NC (28270) · plan year 2026
              {build && (
                <span className="text-slate-500">
                  {" "}· build <code className="font-mono">{build.commit}</code> · corpus{" "}
                  <code className="font-mono">{build.corpusVersion.slice(0, 8)}</code>
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {/* WCAG 1.4.4 wants text resizable, not large by default. */}
            <div className="flex items-center gap-1" role="group" aria-label="Text size">
              {(["compact", "normal", "large"] as const).map((k, idx) => (
                <button
                  key={k}
                  onClick={() => setTextSize(k)}
                  aria-pressed={textSize === k}
                  title={`${k[0].toUpperCase()}${k.slice(1)} text`}
                  className={`rounded border px-1.5 py-0.5 leading-none ${
                    textSize === k
                      ? "border-emerald-700 bg-emerald-800 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                  }`}
                  style={{ fontSize: `${11 + idx * 3}px` }}
                >
                  A
                </button>
              ))}
            </div>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={showTrace}
                onChange={(e) => setShowTrace(e.target.checked)}
                className="h-4 w-4"
              />
              Show reasoning
            </label>
            {identity ? (
              <span className="flex items-center gap-1.5">
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-900">
                  {identity.actingAs
                    ? `${identity.actingAs.name} · for ${identity.firstName}`
                    : identity.name}
                </span>
                <button onClick={signOut} className="text-slate-600 underline">
                  Sign out
                </button>
              </span>
            ) : (
              <button
                onClick={() => setSignInOpen((v) => !v)}
                className="rounded border border-emerald-700 px-2 py-1 font-medium text-emerald-800 hover:bg-emerald-50"
              >
                Sign in
              </button>
            )}
            <a href="/broker" className="text-emerald-800 underline">
              Broker view →
            </a>
            <a href="/admin/feedback" className="text-emerald-800 underline">
              Feedback →
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-4">
        {signInOpen && (
          <div className="mb-4 rounded-xl border-2 border-emerald-300 bg-white p-4">
            <h2 className="text-sm font-semibold">Sign in to your Humana account</h2>
            <p className="mt-1 text-xs text-slate-600">
              <strong>Simulated.</strong> No authentication is implemented. In production this is an
              authenticated session that returns your current plan, the providers on file and your
              pharmacy record — and it is the point at which protected health information enters the
              system. Everything below is fictional.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(options?.members ?? []).map((o) => (
                <button
                  key={o.token}
                  onClick={() => void signIn(o.token)}
                  className="rounded-lg border border-slate-300 p-2.5 text-left hover:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                >
                  <div className="text-sm font-semibold">{o.label}</div>
                  <div className="text-xs text-slate-600">{o.sub}</div>
                </button>
              ))}
              {(options?.delegates ?? []).map((o) => (
                <button
                  key={o.token}
                  onClick={() => void signIn(o.token)}
                  className="rounded-lg border border-slate-300 p-2.5 text-left hover:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                >
                  <div className="text-sm font-semibold">
                    {o.label} <span className="font-normal text-slate-500">· caregiver</span>
                  </div>
                  <div className="text-xs text-slate-600">{o.sub}</div>
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-600">
              Or <button onClick={() => setSignInOpen(false)} className="underline">continue without signing in</button>{" "}
              — the assistant will ask for what it needs. Someone newly eligible has no account to
              sign into, so that path has to work just as well.
            </p>
          </div>
        )}

        {identity && (
          <div className="mb-4 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            {identity.actingAs
              ? `Signed in as ${identity.actingAs.name}, ${identity.actingAs.relationship} of ${identity.name}. You are viewing ${identity.firstName}'s account.`
              : `Signed in as ${identity.name}.`}{" "}
            {identity.currentPlanId ? (
              <>
                Current plan <code className="font-mono">{identity.currentPlanId}</code>
                {identity.planEnding && <strong> — ending for 2027</strong>}. ZIP {identity.zip}.
              </>
            ) : (
              <>No current Humana enrollment on file.</>
            )}{" "}
            The assistant already has this and will not ask you to repeat it.
          </div>
        )}

        {messages.length === 0 && (
          <div className="mb-6">
            <p className="mb-1 text-sm text-slate-700">
              Try one of these, or just type a question below.
            </p>
            <p className="mb-3 text-xs text-slate-500">
              {identity
                ? "Signed in — the assistant already knows the plan, providers and medications on file."
                : "Not signed in — the assistant will ask for what it needs before it can look anything up."}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {STARTERS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setVoiceMode(s.id === "linda");
                    void send(s.prompt);
                  }}
                  className="rounded-xl border-2 border-slate-300 bg-white p-3 text-left transition hover:border-emerald-600 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-emerald-300"
                >
                  <div className="text-xs font-semibold text-slate-600">
                    {s.name}
                    {s.id === "linda" && (
                      <span className="font-normal text-emerald-800"> · reads answers aloud</span>
                    )}
                  </div>
                  <div className="mt-1 text-sm text-slate-800">&ldquo;{s.prompt}&rdquo;</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* role="log" + aria-live announces new messages to screen readers without
            stealing focus — important when replies can be long and the user may be
            mid-way through reading. */}
        <div className="space-y-3" role="log" aria-live="polite" aria-label="Conversation">
          {messages.map((m, i) => (
            <div key={i}>
              <div
                className={
                  m.role === "user"
                    ? `ml-auto max-w-[85%] rounded-2xl bg-emerald-800 ${size.pad} ${size.body} text-white`
                    : `max-w-[95%] rounded-2xl border border-slate-200 bg-white ${size.pad} ${size.body}`
                }
              >
                <span className="sr-only">{m.role === "user" ? "You said: " : "Assistant replied: "}</span>
                {m.attachmentName && (
                  <p className="mb-1 text-xs opacity-90">📎 {m.attachmentName}</p>
                )}
                <RichText text={m.content} />
              </div>
              {m.role === "assistant" && (
                <>
                  {showTrace && m.trace && <TracePanel trace={m.trace} />}
                  {/* Rated per answer rather than per conversation: a reviewer's
                      objection is almost always to one specific claim, and asking at
                      the end of a session loses which turn they meant. */}
                  <FeedbackControls
                    question={messages[i - 1]?.role === "user" ? messages[i - 1].content : ""}
                    answer={m.content}
                    toolsUsed={(m.trace ?? []).map((t) => t.tool)}
                    evidence={(m.trace ?? []).flatMap((t) => t.evidence ?? [])}
                    identityEstablished={identity !== null}
                    uid={`m${i}`}
                    commit={build?.commit ?? "dev"}
                  />
                </>
              )}
            </div>
          ))}

          {loading && (
            <div className={`max-w-[95%] rounded-2xl border border-slate-200 bg-white ${size.pad} ${size.body} text-slate-600`}>
              <span className="inline-block motion-safe:animate-pulse">Looking that up…</span>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-xl border-2 border-red-300 bg-red-50 px-4 py-3 text-red-900">
              {error}
            </div>
          )}

          <div ref={endRef} />
        </div>
      </main>

      <div className="sticky bottom-0 border-t border-slate-200 bg-white px-4 py-4">
        <div className="mx-auto max-w-4xl">
          {attachment && (
            <div className="mb-2 flex items-center gap-3 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={attachment.previewUrl}
                alt={`Preview of ${attachment.name}`}
                className="h-14 w-14 rounded object-cover"
              />
              <div className="flex-1 text-sm">
                <div className="font-medium">{attachment.name}</div>
                <div className="text-slate-600">Will be sent with your next message</div>
              </div>
              <button
                onClick={() => setAttachment(null)}
                className="rounded px-3 py-2 text-slate-700 underline focus:outline-none focus:ring-4 focus:ring-emerald-300"
              >
                Remove
              </button>
            </div>
          )}

          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              aria-label="Attach a photo of your letter"
              title="Attach a photo of your letter"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xl text-slate-800 transition hover:bg-slate-300 focus:outline-none focus:ring-4 focus:ring-emerald-300 sm:h-14 sm:w-14 sm:text-2xl"
            >
              <span aria-hidden="true">📄</span>
            </button>

            {supported.input && (
              <button
                onClick={handleMic}
                aria-label={listening ? "Stop listening" : "Speak your question"}
                aria-pressed={listening}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl transition focus:outline-none focus:ring-4 focus:ring-emerald-300 sm:h-14 sm:w-14 sm:text-2xl ${
                  listening
                    ? "bg-red-700 text-white motion-safe:animate-pulse"
                    : "bg-slate-200 text-slate-800 hover:bg-slate-300"
                }`}
              >
                <span aria-hidden="true">{listening ? "■" : "🎤"}</span>
              </button>
            )}

            {/* Visually hidden label rather than placeholder-as-label: placeholders
                disappear on input and are not reliably announced. WCAG 3.3.2. */}
            <label htmlFor="message-input" className="sr-only">
              Type your question about Medicare plans
            </label>
            <textarea
              id="message-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              /* Short on purpose: at 16px in a ~175px box on a 375px phone, "Type your
                 question…" wraps to a second line and clips. The full wording lives in
                 the visually-hidden label above, so nothing is lost for screen readers. */
              placeholder={listening ? "Listening…" : "Your question…"}
              rows={1}
              /* text-base, not text-sm: iOS Safari zooms the viewport on focus of any
                 input under 16px and does not zoom back out on blur, so one tap on the
                 message box leaves the whole app oversized. */
              className="min-h-12 flex-1 resize-none rounded-xl border-2 border-slate-400 px-3 py-2.5 text-base focus:border-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-200"
            />

            <button
              onClick={() => void send(input)}
              disabled={loading || (!input.trim() && !attachment)}
              className="h-12 shrink-0 rounded-xl bg-emerald-800 px-3 text-sm font-medium text-white focus:outline-none focus:ring-4 focus:ring-emerald-300 disabled:opacity-50 sm:px-5"
            >
              Send
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <div className="flex items-center gap-3">
              {supported.output && (
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={voiceMode}
                    onChange={(e) => {
                      setVoiceMode(e.target.checked);
                      if (!e.target.checked) stopSpeaking();
                    }}
                    className="h-4 w-4"
                  />
                  Read answers aloud
                </label>
              )}
              {speaking && (
                <button onClick={stopSpeaking} className="text-emerald-700 underline">
                  Stop speaking
                </button>
              )}
            </div>
            <span>Never enter your Medicare number, SSN, or bank details here.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
