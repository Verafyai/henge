export const metadata = { title: 'Download' };

/** Download page (SPEC 4.1). No signed public build exists yet, so nothing is offered for download. */
export default function Download() {
  return (
    <div className="mx-auto max-w-[760px] px-4 py-16 sm:px-8">
      <h1 className="text-4xl font-bold tracking-tight text-ink">Get Henge</h1>
      <p className="mt-4 text-lg text-zinc-700">
        Henge by Verafy is the desktop app that runs swarms. The alpha is for macOS only. It runs swarms only while your computer is idle, inside a
        sandbox, and you can pause it from the menu bar at any time.
      </p>
      <p className="mt-6 rounded-card border border-dashed border-zinc-300 p-5 text-zinc-600">
        Public builds are not available yet. Signed releases will be listed here when they ship.
      </p>
    </div>
  );
}
