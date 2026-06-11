import AuthForm from "@/components/AuthForm";

export const metadata = { title: "登录" };

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md">
      <AuthForm mode="login" />
    </div>
  );
}
