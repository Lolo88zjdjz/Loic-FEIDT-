import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, SESSION_COOKIE, verifyCredentials } from "@/core/auth/session";

async function login(formData: FormData) {
  "use server";
  const user = await verifyCredentials(String(formData.get("email") ?? ""), String(formData.get("password") ?? ""));
  if (!user) redirect("/login?error=1");
  const { token, expiresAt } = await createSession(user.id);
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", expires: expiresAt, path: "/" });
  redirect("/");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="min-h-screen grid place-items-center px-4">
      <form action={login} className="card w-full max-w-sm p-7 space-y-4">
        <div>
          <div className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-accent shadow-[0_0_12px_var(--accent)]" /><h1 className="text-lg font-semibold tracking-tight">LOÏC OS</h1></div>
          <p className="text-muted text-[13px] mt-1">Votre environnement numérique personnel.</p>
        </div>
        <label className="block space-y-1"><span className="text-[12px] text-muted">E-mail</span><input className="input" name="email" type="email" autoComplete="username" required /></label>
        <label className="block space-y-1"><span className="text-[12px] text-muted">Mot de passe</span><input className="input" name="password" type="password" autoComplete="current-password" required /></label>
        {error && <p className="text-bad text-[13px]">Identifiants invalides.</p>}
        <button className="btn btn-primary w-full justify-center" type="submit">Se connecter</button>
      </form>
    </main>
  );
}
