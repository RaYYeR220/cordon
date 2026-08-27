import { PayScreen } from "@/components/screens/PayScreen";

export const metadata = {
  title: "Cordon · 01 · Pay",
  description:
    "Compose a gated private payment and watch the gate's enforcement pipeline run against it, step by step.",
};

export default function PayPage() {
  return <PayScreen />;
}
