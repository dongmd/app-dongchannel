import { ProjectView } from "@/components/lumi/project-view";

export default async function LumiProject({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectView id={id} />;
}
