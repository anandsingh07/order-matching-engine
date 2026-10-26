import { useId, type ReactNode } from "react";

/**
 * A titled section of the terminal, labelled by its heading for screen readers.
 * It fills the space it is given unless `fill` is false, when it takes the
 * height of its content and shrinks (scrolling) only if it has to.
 */
export function Panel({
  title,
  aside,
  children,
  className = "",
  fill = true,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  fill?: boolean;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={`flex min-h-0 ${fill ? "flex-1" : "shrink"} flex-col bg-panel ${className}`}>
      <div className="flex h-9 shrink-0 items-center justify-between border-b-2 border-line px-3 text-xs">
        <h2 id={headingId} className="text-text">
          {title}
        </h2>
        {aside !== undefined && <div className="text-muted">{aside}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}
