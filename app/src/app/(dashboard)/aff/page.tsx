import { redirect } from "next/navigation";

// Index redirect → /aff/offers (tab mặc định).
export default function AffIndex() {
  redirect("/aff/offers");
}
