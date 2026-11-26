export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-3xl font-bold text-ink">Page not found</h1>
      <p className="mt-3 text-ink-2">That swarm or page does not exist.</p>
      <a href="/swarms" className="mt-6 inline-flex min-h-10 items-center font-semibold text-brand">Back to swarms</a>
    </div>
  );
}
