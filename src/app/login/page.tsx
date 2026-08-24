import type { Metadata } from "next";
import { LoginForm } from "./login-form";
import styles from "./login.module.css";

export const metadata: Metadata = {
  title: "Sign in · E3 ERP",
  description: "Sign in to the E3 Energy business operations workspace.",
};

export default function LoginPage() {
  return (
    <main className={styles.page}>
      <div className={styles.backdrop} aria-hidden="true">
        <span className={styles.glowOne} />
        <span className={styles.glowTwo} />
        <span className={styles.grid} />
      </div>

      <section className={styles.card} aria-labelledby="login-title">
        <header className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.logo} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className={styles.brandName}>E3 ERP</span>
          </div>

          <div className={styles.heading}>
            <p className={styles.eyebrow}>E3 Energy workspace</p>
            <h1 id="login-title">Welcome back</h1>
            <p>Sign in to continue to your business operations workspace.</p>
          </div>
        </header>

        <LoginForm />

        <footer className={styles.footer}>
          <span className={styles.statusDot} aria-hidden="true" />
          <span>Secure team access</span>
        </footer>
      </section>
    </main>
  );
}
