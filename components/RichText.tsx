/**
 * Minimal renderer for the small subset of Markdown the model actually produces:
 * bold spans, bullet lists, and numbered lists.
 *
 * Deliberately not a Markdown library. The full spec would let arbitrary model
 * output drive arbitrary rendering — including links and images — which is a wider
 * surface than a prototype in a regulated setting needs. This handles what appears
 * in practice and renders anything else as plain text.
 */

import { Fragment, type ReactNode } from "react";

/** Split on **bold** and return React nodes. */
function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;

  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (line === "") {
      flush();
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);

    if (bullet) {
      if (current?.kind !== "ul") {
        flush();
        current = { kind: "ul", items: [] };
      }
      (current as { kind: "ul"; items: string[] }).items.push(bullet[1]);
    } else if (numbered) {
      if (current?.kind !== "ol") {
        flush();
        current = { kind: "ol", items: [] };
      }
      (current as { kind: "ol"; items: string[] }).items.push(numbered[1]);
    } else {
      if (current?.kind !== "p") {
        flush();
        current = { kind: "p", lines: [] };
      }
      (current as { kind: "p"; lines: string[] }).lines.push(line);
    }
  }
  flush();
  return blocks;
}

export function RichText({ text }: { text: string }) {
  const blocks = parse(text);

  return (
    <>
      {blocks.map((block, i) => {
        const spacing = i > 0 ? "mt-3" : "";

        if (block.kind === "ul") {
          return (
            <ul key={i} className={`${spacing} list-disc space-y-1 pl-6`}>
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "ol") {
          return (
            <ol key={i} className={`${spacing} list-decimal space-y-1 pl-6`}>
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i} className={spacing}>
            {inline(block.lines.join(" "))}
          </p>
        );
      })}
    </>
  );
}
