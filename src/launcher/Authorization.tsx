import { FormEvent, useState } from "react";
import { t } from "@shared";
import { useAuth } from "../context/AuthContext";

/** Two steps: the email gets a one-time code, then the code signs in. */
export default function GetUserData() {
  const { requestCode, verifyCode, error } = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      if (codeSent) await verifyCode(email.trim(), code.trim());
      else {
        await requestCode(email.trim());
        setCodeSent(true);
      }
    } catch {
      // `error` from the auth context shows it.
    } finally {
      setSubmitting(false);
    }
  }

  const ready = codeSent ? !!code.trim() : !!email.trim();

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem", width: "100%", maxWidth: "280px" }}
    >
      <input
        type="email"
        placeholder={t("field_email", "Email")}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        disabled={codeSent}
      />
      {codeSent && (
        <>
          <p style={{ fontSize: "0.85rem", margin: 0, opacity: 0.8 }}>
            {t("auth_code_sent", "We emailed you a code. Enter it below.")}
          </p>
          <input
            type="text"
            inputMode="numeric"
            placeholder={t("field_code", "Code")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoFocus
          />
        </>
      )}
      {error && <p style={{ color: "#ff6b6b", fontSize: "0.85rem", margin: 0 }}>{error}</p>}
      <button type="submit" disabled={submitting || !ready}>
        {codeSent
          ? submitting ? t("auth_signing_in", "Signing in...") : t("auth_sign_in", "Sign in")
          : submitting ? t("auth_sending", "Sending...") : t("auth_send_code", "Send code")}
      </button>
      {codeSent && (
        <button type="button" disabled={submitting} onClick={() => { setCodeSent(false); setCode(""); }}>
          {t("auth_change_email", "Use another email")}
        </button>
      )}
    </form>
  );
}
