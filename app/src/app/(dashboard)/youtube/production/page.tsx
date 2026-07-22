import { redirect } from "next/navigation";

// Production tab = filter view: SCRIPTING + PRODUCING + SCHEDULED
export default function ProductionRedirect() {
  redirect("/youtube/videos?status=SCRIPTING");
}
