export function Footer() {
  return (
    <footer className="wrap mt-24 border-t border-line py-10 text-[13px] text-ink-2">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p>Built at NEAR HACKATHON 2026 · testnet · <a className="link" href="https://github.com/Manvith-Shetty/fuse" target="_blank" rel="noreferrer">Repository</a></p>
        <p>Verdicts are <span className="text-accent-deep font-medium">allow</span>, <span className="text-amber font-medium">warn</span> or <span className="text-red font-medium">block</span>.</p>
      </div>
    </footer>
  );
}
