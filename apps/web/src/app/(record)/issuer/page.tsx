import { IssuerScreen } from "@/components/screens/IssuerScreen";

export const metadata = {
  title: "Cordon · 03 · Issuer console",
  description: "Issue a credential, revoke one, and read the register of published policies.",
};

export default function IssuerPage() {
  return <IssuerScreen />;
}
