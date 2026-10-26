import { useShallow } from "zustand/react/shallow";
import { useTerminal } from "@/lib/store";

export function Notices() {
  const { notices, dismiss } = useTerminal(useShallow((s) => ({ notices: s.notices, dismiss: s.dismiss })));
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {notices.map((n) => (
        <button
          key={n.id}
          onClick={() => dismiss(n.id)}
          className={`pointer-events-auto rounded-md border-2 border-ink px-3 py-2 text-left text-xs font-semibold text-ink shadow-brutal ${
            n.kind === "error" ? "bg-sell-fill" : "bg-cyan"
          }`}
        >
          {n.text}
        </button>
      ))}
    </div>
  );
}
