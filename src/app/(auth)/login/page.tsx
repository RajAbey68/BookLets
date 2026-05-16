import { signIn } from "@/auth";

// Reads the database (via the auth() callback) and cannot be prerendered.
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const { callbackUrl: cb, error } = await searchParams;
  const callbackUrl = cb ?? "/";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        background: "var(--bg-color, #0a0a0a)",
      }}
    >
      <div
        className="glass-card"
        style={{
          padding: "3rem",
          maxWidth: "420px",
          width: "100%",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: "0.875rem",
            color: "var(--accent-color)",
            fontWeight: 600,
            marginBottom: "0.5rem",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          BookLets
        </div>
        <h1 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Sign in</h1>
        <p
          style={{
            color: "var(--text-secondary)",
            marginBottom: "2rem",
            lineHeight: 1.5,
          }}
        >
          Sign in with your Google account to access the portfolio.
        </p>

        {error ? (
          <div
            role="alert"
            style={{
              marginBottom: "1.5rem",
              padding: "0.75rem 1rem",
              borderRadius: "8px",
              border: "1px solid var(--danger-color, #b91c1c)",
              color: "var(--danger-color, #b91c1c)",
              fontSize: "0.875rem",
            }}
          >
            {error === "AccessDenied"
              ? "Your account is not authorised to access BookLets. Contact your administrator."
              : "Sign-in failed. Try again."}
          </div>
        ) : null}

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: callbackUrl });
          }}
        >
          <button
            type="submit"
            className="btn-primary"
            style={{
              width: "100%",
              padding: "0.875rem 1.25rem",
              borderRadius: "10px",
              background: "var(--accent-color)",
              border: "none",
              color: "#fff",
              fontWeight: 600,
              fontSize: "0.9375rem",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.75rem",
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              aria-hidden="true"
            >
              <path
                fill="#fff"
                d="M21.35 11.1H12v3.83h5.35c-.5 2.5-2.78 4.07-5.35 4.07a5.83 5.83 0 0 1 0-11.66c1.4 0 2.7.5 3.7 1.35l2.8-2.8A9.83 9.83 0 1 0 12 21.83c5.7 0 9.5-4 9.5-9.66 0-.66-.06-1.27-.15-1.07z"
              />
            </svg>
            Continue with Google
          </button>
        </form>
      </div>
    </main>
  );
}
