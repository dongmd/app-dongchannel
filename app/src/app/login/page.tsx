"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

// Auth.js v4 error codes -> AC10 error message (chung, không lộ email).
const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: "Tài khoản chưa được cấp quyền truy cập.",
  Configuration: "Cấu hình đăng nhập chưa sẵn sàng. Vui lòng liên hệ quản trị.",
  Verification: "Đường dẫn xác thực không hợp lệ hoặc đã hết hạn.",
  OAuthSignin: "Không kết nối được Google. Thử lại sau ít phút.",
  OAuthCallback: "Không nhận được phản hồi từ Google. Thử lại.",
  OAuthCreateAccount: "Không tạo được tài khoản. Liên hệ quản trị.",
  Callback: "Đăng nhập không thành công. Thử lại.",
  default: "Đăng nhập không thành công. Thử lại.",
};

function LoginContent() {
  const params = useSearchParams();
  const errorCode = params.get("error");
  const callbackUrl = params.get("callbackUrl") ?? "/";
  const errorMessage = errorCode ? ERROR_MESSAGES[errorCode] ?? ERROR_MESSAGES.default : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <header className="space-y-2 text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          DongChannel · Operations Hub
        </p>
        <h1 className="text-2xl font-semibold">Đăng nhập</h1>
        <p className="text-sm text-muted-foreground">
          Chỉ tài khoản trong danh sách cho phép được truy cập.
        </p>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => signIn("google", { callbackUrl })}
        className="flex w-full items-center justify-center gap-3 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <GoogleIcon />
        Đăng nhập với Google
      </button>

      <p className="text-center text-xs text-muted-foreground">
        Bằng cách đăng nhập, bạn đồng ý ghi lại phiên truy cập trong nhật ký hệ thống.
      </p>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.44c-.28 1.4-1.09 2.59-2.32 3.4v2.82h3.75c2.2-2.03 3.62-5.02 3.62-8.46z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.94-2.94l-3.75-2.82c-1.08.72-2.44 1.16-4.19 1.16-3.22 0-5.95-2.17-6.93-5.1H1.19v3.22C3.15 21.3 7.25 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.07 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.49H1.19C.43 8.02 0 9.72 0 12s.43 3.98 1.19 5.51l3.88-3.22z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.32-3.32C17.95 1.19 15.24 0 12 0 7.25 0 3.15 2.7 1.19 6.49l3.88 3.22C6.05 6.92 8.78 4.75 12 4.75z"
      />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
