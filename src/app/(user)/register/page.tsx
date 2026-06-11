import AuthForm from "@/components/AuthForm";

export const metadata = { title: "注册" };

export default function RegisterPage() {
  return (
    <div className="mx-auto max-w-md">
      <AuthForm mode="register" />
    </div>
  );
}
