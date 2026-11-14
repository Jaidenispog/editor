'use client';

/** Last-resort error screen when the root layout itself fails. Uses inline styles because CSS may not have loaded. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-AU">
      <body style={{ fontFamily: 'system-ui, sans-serif', display: 'grid', placeItems: 'center', minHeight: '100vh', margin: 0, background: '#f6f6f7', color: '#1c1d20' }}>
        <main style={{ textAlign: 'center', padding: 24 }}>
          <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
          <p style={{ color: '#52555c' }}>The app hit an unexpected problem. Please try again.</p>
          <button type="button" onClick={reset} style={{ marginTop: 16, padding: '10px 18px', borderRadius: 10, border: 0, background: '#1c1d20', color: '#fff', cursor: 'pointer' }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
