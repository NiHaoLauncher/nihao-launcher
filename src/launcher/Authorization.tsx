import { FormEvent, useState } from "react";
import { useAuth } from "../context/AuthContext";

export default function GetUserData() {
  const { login, error } = useAuth();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!loginId.trim() || !password || submitting) return;
    setSubmitting(true);
    try {
      await login(loginId.trim(), password);
    } catch {
      // surfaced via useAuth().error
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem", width: "100%", maxWidth: "280px" }}
    >
      <input
        type="text"
        placeholder="Login"
        value={loginId}
        onChange={(e) => setLoginId(e.target.value)}
        autoComplete="username"
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
      />
      {error && <p style={{ color: "#ff6b6b", fontSize: "0.85rem", margin: 0 }}>{error}</p>}
      <button type="submit" disabled={submitting || !loginId.trim() || !password}>
        {submitting ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
