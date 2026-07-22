import { redirect } from "next/navigation";

// Ideas tab = filter view: IDEA + VALIDATING + APPROVED
export default function IdeasRedirect() {
  redirect("/youtube/videos?status=IDEA");
}
