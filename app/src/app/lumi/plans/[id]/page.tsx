import { PlanView } from "@/components/lumi/plan-view";

export default async function LumiPlan({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlanView id={id} />;
}
