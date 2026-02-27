export function App() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ maxWidth: 720, padding: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Chat App Rewrite Shell</h1>
        <p style={{ marginTop: 12, lineHeight: 1.6 }}>
          Phase 1 completed: new app shell is independent from Next.js runtime.
          Existing UI components can now be migrated selectively into this shell.
        </p>
      </div>
    </main>
  )
}
