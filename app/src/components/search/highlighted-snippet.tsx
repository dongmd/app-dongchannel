// Render snippet có <mark>...</mark> từ ts_headline một cách SAFE (no XSS).
// Parse strict: chỉ chấp nhận tag <mark></mark>, escape mọi HTML khác.

const MARK_TAG_REGEX = /<mark>|<\/mark>/g;

interface Fragment {
  text: string;
  highlighted: boolean;
}

function parseFragments(input: string): Fragment[] {
  // Tokenize: chỉ chấp nhận <mark> và </mark>, escape mọi thứ khác.
  const fragments: Fragment[] = [];
  let inMark = false;
  let pos = 0;
  const matches: { type: "open" | "close"; index: number }[] = [];
  for (const m of input.matchAll(MARK_TAG_REGEX)) {
    matches.push({ type: m[0].startsWith("</") ? "close" : "open", index: m.index ?? 0 });
  }
  for (const m of matches) {
    const text = input.slice(pos, m.index);
    if (text) fragments.push({ text, highlighted: inMark });
    inMark = m.type === "open";
    pos = m.index + (m.type === "open" ? 6 : 7); // '<mark>' = 6, '</mark>' = 7
  }
  const tail = input.slice(pos);
  if (tail) fragments.push({ text: tail, highlighted: inMark });

  // If no marks at all, treat whole input as plain fragment.
  if (fragments.length === 0) return [{ text: input, highlighted: false }];
  return fragments;
}

export function HighlightedSnippet({ snippet }: { snippet: string }) {
  const fragments = parseFragments(snippet);
  return (
    <span className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
      {fragments.map((f, i) =>
        f.highlighted ? (
          <mark key={i} className="rounded bg-primary/25 px-0.5 text-foreground">
            {f.text}
          </mark>
        ) : (
          <span key={i}>{f.text}</span>
        ),
      )}
    </span>
  );
}
