"use client";

import { Eye, EyeOff, LoaderCircle, LockKeyhole, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import styles from "./login.module.css";

type LoginErrorResponse = {
  error?: unknown;
};

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      setError("Enter your username and password.");
      return;
    }

    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: normalizedUsername, password }),
        cache: "no-store",
        credentials: "same-origin",
      });

      let body: LoginErrorResponse = {};
      try {
        body = await response.json() as LoginErrorResponse;
      } catch {
        // The status code remains authoritative if the response has no JSON body.
      }

      if (!response.ok) {
        setError(typeof body.error === "string" && body.error.trim()
          ? body.error
          : "Unable to sign in. Check your details and try again.");
        setIsSubmitting(false);
        return;
      }

      const requestedDestination = new URLSearchParams(window.location.search).get("next") || "/";
      const destination = requestedDestination.startsWith("/") && !requestedDestination.startsWith("//")
        ? requestedDestination
        : "/";
      router.replace(destination);
      router.refresh();
    } catch {
      setError("The service is unavailable right now. Please try again.");
      setIsSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <div className={styles.field}>
        <label htmlFor="username">Username</label>
        <div className={styles.inputShell}>
          <UserRound size={18} aria-hidden="true" />
          <input
            id="username"
            name="username"
            type="text"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              if (error) setError("");
            }}
            placeholder="Enter your username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            disabled={isSubmitting}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "login-error" : undefined}
            autoFocus
          />
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="password">Password</label>
        <div className={styles.inputShell}>
          <LockKeyhole size={18} aria-hidden="true" />
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) setError("");
            }}
            placeholder="Enter your password"
            autoComplete="current-password"
            disabled={isSubmitting}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "login-error" : undefined}
          />
          <button
            className={styles.passwordToggle}
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            disabled={isSubmitting}
          >
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
      </div>

      <div
        id="login-error"
        className={`${styles.error} ${error ? styles.errorVisible : ""}`}
        role={error ? "alert" : undefined}
        aria-live="polite"
      >
        {error || "\u00a0"}
      </div>

      <button
        className={styles.submitButton}
        type="submit"
        disabled={isSubmitting}
        aria-busy={isSubmitting}
      >
        {isSubmitting && <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" />}
        <span>{isSubmitting ? "Signing in…" : "Sign in"}</span>
      </button>
    </form>
  );
}
