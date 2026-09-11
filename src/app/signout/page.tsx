import SignOutForm from "./signout-form";

/**
 * A confirmation page exposes no account data and must remain reachable when a
 * session has expired or the identity database is unavailable. GET does not log
 * anyone out; the existing Auth.js POST still validates a fresh CSRF pair.
 */
export default function SignOutPage() {
  return <SignOutForm />;
}
