import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "LOÏC OS", description: "Second Brain personnel multi-agents" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('loic-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
