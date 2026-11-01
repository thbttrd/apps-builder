/** The "/" page. AppShell draws the frame around it; this owns the padding and the columns. */
export default function Home() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8 lg:px-10 lg:py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight md:text-3xl">New app</h1>
      <p className="mt-2 text-ink-muted">Edit src/Home.tsx and it updates here.</p>
      {/* One of each: a full-bleed list on a phone, cards in a grid from a tablet up. */}
      <ul className="-mx-4 mt-6 divide-y divide-hairline border-y border-hairline bg-surface md:mx-0 md:grid md:grid-cols-2 md:gap-4 md:divide-y-0 md:border-0 md:bg-transparent lg:mt-8 lg:grid-cols-3 lg:gap-6">
        {SIZES.map((s) => (
          <li key={s.name} className="px-4 py-4 md:rounded-lg md:border md:border-hairline md:bg-surface md:p-5">
            <p className="flex items-center gap-2 font-medium">
              {s.name} <span className="text-sm font-normal text-ink-muted">{s.from}</span>
              <span className={`ml-auto rounded-full bg-primary px-2 py-0.5 text-xs text-on-primary ${s.live}`}>this one</span>
            </p>
            <p className="mt-1 text-sm text-ink-muted">{s.shape}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Each badges itself at the size it describes, so the preview's device buttons show which is live. */
const SIZES = [
  { name: 'Phone', from: 'unprefixed', shape: 'One column, edge to edge, tabs at the bottom.', live: 'md:hidden' },
  { name: 'Tablet', from: 'md: 768px+', shape: 'A rail of icons, two columns side by side.', live: 'hidden md:inline-flex lg:hidden' },
  { name: 'Desktop', from: 'lg: 1024px+', shape: 'A sidebar with labels, three columns or more.', live: 'hidden lg:inline-flex' },
]
