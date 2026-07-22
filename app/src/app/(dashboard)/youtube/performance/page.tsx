import { redirect } from "next/navigation";

// Performance tab = filter view: PUBLISHED + REVIEWED
export default function PerformanceRedirect() {
  redirect("/youtube/videos?status=PUBLISHED");
}
